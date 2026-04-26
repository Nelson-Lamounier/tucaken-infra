import {
  AutoScalingClient,
  UpdateAutoScalingGroupCommand,
} from '@aws-sdk/client-auto-scaling';
import {
  CreateLaunchTemplateVersionCommand,
  EC2Client,
  ModifyLaunchTemplateCommand,
} from '@aws-sdk/client-ec2';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';

import { handler } from '../../../../lib/constructs/events/ami-refresh/handlers/update-launch-template';

const ec2Mock = mockClient(EC2Client);
const ssmMock = mockClient(SSMClient);
const asgMock = mockClient(AutoScalingClient);

// Helper: set up mocks for a workers event with N LT/ASG pairs
function setupWorkerMocks(ltNames: string[], asgNames: string[], versions: number[]): void {
  ssmMock.on(GetParameterCommand, { Name: '/k8s/development/golden-ami/latest' })
    .resolvesOnce({ Parameter: { Value: 'ami-0newimage123' } });
  ssmMock.on(GetParameterCommand, { Name: '/k8s/development/ami-refresh/workers/lt-names' })
    .resolvesOnce({ Parameter: { Value: JSON.stringify(ltNames) } });
  ssmMock.on(GetParameterCommand, { Name: '/k8s/development/ami-refresh/workers/asg-names' })
    .resolvesOnce({ Parameter: { Value: JSON.stringify(asgNames) } });
  // Chain resolvesOnce on the same stub so multiple responses queue correctly.
  const createStub = ec2Mock.on(CreateLaunchTemplateVersionCommand);
  const modifyStub = ec2Mock.on(ModifyLaunchTemplateCommand);
  const asgStub = asgMock.on(UpdateAutoScalingGroupCommand);
  versions.forEach(v => {
    createStub.resolvesOnce({ LaunchTemplateVersion: { VersionNumber: v } });
    modifyStub.resolvesOnce({});
    asgStub.resolvesOnce({});
  });
}

describe('update-launch-template', () => {
  const event = { paramName: '/k8s/development/golden-ami/latest', role: 'workers' as const };

  beforeEach(() => {
    ec2Mock.reset();
    ssmMock.reset();
    asgMock.reset();
  });

  it('should read AMI ID from the paramName SSM parameter', async () => {
    setupWorkerMocks(['lt-abc123'], ['asg-abc123'], [5]);

    const result = await handler(event);

    expect(result.amiId).toBe('ami-0newimage123');
    expect(result.env).toBe('development');
    expect(result.role).toBe('workers');
  });

  it('should create a new LT version with the new AMI ID', async () => {
    setupWorkerMocks(['lt-abc123'], ['asg-abc123'], [7]);

    await handler(event);

    expect(ec2Mock.commandCalls(CreateLaunchTemplateVersionCommand)[0]?.args[0].input).toMatchObject({
      LaunchTemplateName: 'lt-abc123',
      SourceVersion: '$Latest',
      LaunchTemplateData: { ImageId: 'ami-0newimage123' },
    });
  });

  it('should set the new version as the LT default', async () => {
    setupWorkerMocks(['lt-abc123'], ['asg-abc123'], [7]);

    await handler(event);

    expect(ec2Mock.commandCalls(ModifyLaunchTemplateCommand)[0]?.args[0].input).toMatchObject({
      LaunchTemplateName: 'lt-abc123',
      DefaultVersion: '7',
    });
  });

  it('should update ASG to $Default after setting new LT default', async () => {
    setupWorkerMocks(['lt-abc123'], ['asg-abc123'], [7]);

    await handler(event);

    expect(asgMock.commandCalls(UpdateAutoScalingGroupCommand)[0]?.args[0].input).toMatchObject({
      AutoScalingGroupName: 'asg-abc123',
      LaunchTemplate: { LaunchTemplateName: 'lt-abc123', Version: '$Default' },
    });
  });

  it('should update all LTs and ASGs in the worker pool', async () => {
    setupWorkerMocks(['lt-111', 'lt-222'], ['asg-111', 'asg-222'], [3, 3]);

    await handler(event);

    expect(ec2Mock.commandCalls(CreateLaunchTemplateVersionCommand)).toHaveLength(2);
    expect(asgMock.commandCalls(UpdateAutoScalingGroupCommand)).toHaveLength(2);
  });

  it('should read control-plane/lt-name and asg-name when role is control-plane', async () => {
    const cpEvent = { paramName: '/k8s/development/golden-ami/latest', role: 'control-plane' as const };
    ssmMock.on(GetParameterCommand, { Name: '/k8s/development/golden-ami/latest' })
      .resolvesOnce({ Parameter: { Value: 'ami-0newimage123' } });
    ssmMock.on(GetParameterCommand, { Name: '/k8s/development/ami-refresh/control-plane/lt-name' })
      .resolvesOnce({ Parameter: { Value: 'lt-cp-999' } });
    ssmMock.on(GetParameterCommand, { Name: '/k8s/development/ami-refresh/control-plane/asg-name' })
      .resolvesOnce({ Parameter: { Value: 'asg-cp-999' } });
    ec2Mock.on(CreateLaunchTemplateVersionCommand).resolvesOnce({ LaunchTemplateVersion: { VersionNumber: 2 } });
    ec2Mock.on(ModifyLaunchTemplateCommand).resolvesOnce({});
    asgMock.on(UpdateAutoScalingGroupCommand).resolvesOnce({});

    await handler(cpEvent);

    expect(asgMock.commandCalls(UpdateAutoScalingGroupCommand)[0]?.args[0].input).toMatchObject({
      AutoScalingGroupName: 'asg-cp-999',
      LaunchTemplate: { LaunchTemplateName: 'lt-cp-999', Version: '$Default' },
    });
  });
});
