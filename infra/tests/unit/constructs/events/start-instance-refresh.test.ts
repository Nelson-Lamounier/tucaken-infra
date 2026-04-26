import {
  AutoScalingClient,
  StartInstanceRefreshCommand,
} from '@aws-sdk/client-auto-scaling';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';

import { handler } from '../../../../lib/constructs/events/ami-refresh/handlers/start-instance-refresh';

const asgMock = mockClient(AutoScalingClient);
const ssmMock = mockClient(SSMClient);

describe('start-instance-refresh', () => {
  const event = { paramName: '/k8s/development/golden-ami/latest', role: 'workers' as const };

  beforeEach(() => {
    asgMock.reset();
    ssmMock.reset();
  });

  it('should start a refresh on each worker ASG', async () => {
    ssmMock.on(GetParameterCommand).resolvesOnce({
      Parameter: { Value: JSON.stringify(['asg-general', 'asg-monitoring']) },
    });
    asgMock.on(StartInstanceRefreshCommand)
      .resolvesOnce({ InstanceRefreshId: 'refresh-111' })
      .resolvesOnce({ InstanceRefreshId: 'refresh-222' });

    const result = await handler(event);

    expect(result.refreshIds).toHaveLength(2);
    expect(result.refreshIds[0]).toStrictEqual({ asgName: 'asg-general', refreshId: 'refresh-111' });
    expect(result.refreshIds[1]).toStrictEqual({ asgName: 'asg-monitoring', refreshId: 'refresh-222' });
  });

  it('should use MinHealthyPercentage=0 and InstanceWarmup=60', async () => {
    ssmMock.on(GetParameterCommand).resolvesOnce({
      Parameter: { Value: JSON.stringify(['asg-general']) },
    });
    asgMock.on(StartInstanceRefreshCommand).resolvesOnce({ InstanceRefreshId: 'refresh-abc' });

    await handler(event);

    expect(asgMock.commandCalls(StartInstanceRefreshCommand)[0]?.args[0].input).toMatchObject({
      Preferences: { MinHealthyPercentage: 0, InstanceWarmup: 60 },
    });
  });

  it('should read control-plane/asg-name (scalar) when role is control-plane', async () => {
    const cpEvent = { paramName: '/k8s/development/golden-ami/latest', role: 'control-plane' as const };
    ssmMock.on(GetParameterCommand).resolvesOnce({ Parameter: { Value: 'asg-control-plane' } });
    asgMock.on(StartInstanceRefreshCommand).resolvesOnce({ InstanceRefreshId: 'refresh-cp' });

    const result = await handler(cpEvent);

    expect(result.refreshIds).toHaveLength(1);
    expect(result.refreshIds[0]).toStrictEqual({ asgName: 'asg-control-plane', refreshId: 'refresh-cp' });
    expect(ssmMock.commandCalls(GetParameterCommand)[0]?.args[0].input).toMatchObject({
      Name: '/k8s/development/ami-refresh/control-plane/asg-name',
    });
  });

  it('should return env and role in result', async () => {
    ssmMock.on(GetParameterCommand).resolvesOnce({
      Parameter: { Value: JSON.stringify(['asg-general']) },
    });
    asgMock.on(StartInstanceRefreshCommand).resolvesOnce({ InstanceRefreshId: 'refresh-xyz' });

    const result = await handler(event);

    expect(result.env).toBe('development');
    expect(result.role).toBe('workers');
  });

  it('should use workers SSM path for asg-names', async () => {
    ssmMock.on(GetParameterCommand).resolvesOnce({
      Parameter: { Value: JSON.stringify(['asg-general']) },
    });
    asgMock.on(StartInstanceRefreshCommand).resolvesOnce({ InstanceRefreshId: 'refresh-xyz' });

    await handler(event);

    expect(ssmMock.commandCalls(GetParameterCommand)[0]?.args[0].input).toMatchObject({
      Name: '/k8s/development/ami-refresh/workers/asg-names',
    });
  });
});
