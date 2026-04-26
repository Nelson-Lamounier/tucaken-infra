import {
  AutoScalingClient,
  DescribeInstanceRefreshesCommand,
} from '@aws-sdk/client-auto-scaling';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';

import { handler } from '../../../../lib/constructs/events/ami-refresh/handlers/check-refresh-status';

const ssmMock = mockClient(SSMClient);
const asgMock = mockClient(AutoScalingClient);

describe('check-refresh-status', () => {
  const event = { paramName: '/k8s/development/golden-ami/latest', role: 'workers' as const };

  beforeEach(() => {
    ssmMock.reset();
    asgMock.reset();
  });

  it('should return COMPLETE when all ASG refreshes are Successful', async () => {
    ssmMock.on(GetParameterCommand).resolvesOnce({
      Parameter: { Value: JSON.stringify(['k8s-development-general-asg']) },
    });
    asgMock.on(DescribeInstanceRefreshesCommand).resolvesOnce({
      InstanceRefreshes: [{
        Status: 'Successful',
        StartTime: new Date(Date.now() - 5 * 60 * 1000),
      }],
    });

    const result = await handler(event);
    expect(result).toStrictEqual({ status: 'COMPLETE', detail: null });
  });

  it('should return IN_PROGRESS when a refresh is still running', async () => {
    ssmMock.on(GetParameterCommand).resolvesOnce({
      Parameter: { Value: JSON.stringify(['k8s-development-general-asg']) },
    });
    asgMock.on(DescribeInstanceRefreshesCommand).resolvesOnce({
      InstanceRefreshes: [{
        Status: 'InProgress',
        StartTime: new Date(Date.now() - 2 * 60 * 1000),
      }],
    });

    const result = await handler(event);
    expect(result.status).toBe('IN_PROGRESS');
  });

  it('should return FAILED when a refresh has Failed status', async () => {
    ssmMock.on(GetParameterCommand).resolvesOnce({
      Parameter: { Value: JSON.stringify(['k8s-development-general-asg']) },
    });
    asgMock.on(DescribeInstanceRefreshesCommand).resolvesOnce({
      InstanceRefreshes: [{
        Status: 'Failed',
        StatusReason: 'Launch template invalid',
        StartTime: new Date(Date.now() - 3 * 60 * 1000),
      }],
    });

    const result = await handler(event);
    expect(result.status).toBe('FAILED');
    expect(result.detail).toContain('Failed');
  });

  it('should return FAILED when a refresh has Cancelled status', async () => {
    ssmMock.on(GetParameterCommand).resolvesOnce({
      Parameter: { Value: JSON.stringify(['k8s-development-general-asg']) },
    });
    asgMock.on(DescribeInstanceRefreshesCommand).resolvesOnce({
      InstanceRefreshes: [{
        Status: 'Cancelled',
        StatusReason: 'User cancelled',
        StartTime: new Date(Date.now() - 3 * 60 * 1000),
      }],
    });

    const result = await handler(event);
    expect(result.status).toBe('FAILED');
    expect(result.detail).toContain('Cancelled');
  });

  it('should return FAILED when a refresh has RollbackFailed status', async () => {
    ssmMock.on(GetParameterCommand).resolvesOnce({
      Parameter: { Value: JSON.stringify(['k8s-development-general-asg']) },
    });
    asgMock.on(DescribeInstanceRefreshesCommand).resolvesOnce({
      InstanceRefreshes: [{
        Status: 'RollbackFailed',
        StatusReason: 'Rollback failed',
        StartTime: new Date(Date.now() - 10 * 60 * 1000),
      }],
    });

    const result = await handler(event);
    expect(result.status).toBe('FAILED');
    expect(result.detail).toContain('RollbackFailed');
  });

  it('should return FAILED when refresh exceeds MAX_WAIT_MINUTES', async () => {
    ssmMock.on(GetParameterCommand).resolvesOnce({
      Parameter: { Value: JSON.stringify(['k8s-development-general-asg']) },
    });
    asgMock.on(DescribeInstanceRefreshesCommand).resolvesOnce({
      InstanceRefreshes: [{
        Status: 'InProgress',
        StartTime: new Date(Date.now() - 45 * 60 * 1000),
      }],
    });

    const result = await handler(event);
    expect(result.status).toBe('FAILED');
    expect(result.detail).toContain('timed out');
  });

  it('should return FAILED when no refreshes are found for an ASG', async () => {
    ssmMock.on(GetParameterCommand).resolvesOnce({
      Parameter: { Value: JSON.stringify(['k8s-development-general-asg']) },
    });
    asgMock.on(DescribeInstanceRefreshesCommand).resolvesOnce({
      InstanceRefreshes: [],
    });

    const result = await handler(event);
    expect(result.status).toBe('FAILED');
    expect(result.detail).toContain('No refresh found');
  });

  it('should read control-plane/asg-name (not array) when role is control-plane', async () => {
    const cpEvent = { paramName: '/k8s/development/golden-ami/latest', role: 'control-plane' as const };
    ssmMock.on(GetParameterCommand).resolvesOnce({
      Parameter: { Value: 'k8s-development-control-plane-asg' },
    });
    asgMock.on(DescribeInstanceRefreshesCommand).resolvesOnce({
      InstanceRefreshes: [{ Status: 'Successful', StartTime: new Date() }],
    });

    const result = await handler(cpEvent);
    expect(result.status).toBe('COMPLETE');
    expect(ssmMock.commandCalls(GetParameterCommand)[0]?.args[0].input).toMatchObject({
      Name: '/k8s/development/ami-refresh/control-plane/asg-name',
    });
  });
});
