import type { AutoScalingClient } from '@aws-sdk/client-auto-scaling';
import type { SSMClient } from '@aws-sdk/client-ssm';
import { handler } from '../../../../lib/constructs/events/ami-refresh/handlers/start-instance-refresh';

const mockAsgSend = jest.fn();
const mockSsmSend = jest.fn();
const mockAsg = { send: mockAsgSend } as unknown as AutoScalingClient;
const mockSsm = { send: mockSsmSend } as unknown as SSMClient;

beforeEach(() => {
  mockAsgSend.mockReset();
  mockSsmSend.mockReset();
});

describe('start-instance-refresh', () => {
  const event = { paramName: '/k8s/development/golden-ami/latest', role: 'workers' as const };

  it('starts a refresh on each worker ASG', async () => {
    mockSsmSend.mockResolvedValueOnce({ Parameter: { Value: JSON.stringify(['asg-general', 'asg-monitoring']) } });
    mockAsgSend
      .mockResolvedValueOnce({ InstanceRefreshId: 'refresh-111' })
      .mockResolvedValueOnce({ InstanceRefreshId: 'refresh-222' });

    const result = await handler(event, mockAsg, mockSsm);

    expect(result.refreshIds).toHaveLength(2);
    expect(result.refreshIds[0]).toEqual({ asgName: 'asg-general', refreshId: 'refresh-111' });
    expect(result.refreshIds[1]).toEqual({ asgName: 'asg-monitoring', refreshId: 'refresh-222' });
  });

  it('uses MinHealthyPercentage=0 and InstanceWarmup=60', async () => {
    mockSsmSend.mockResolvedValueOnce({ Parameter: { Value: JSON.stringify(['asg-general']) } });
    mockAsgSend.mockResolvedValueOnce({ InstanceRefreshId: 'refresh-abc' });

    await handler(event, mockAsg, mockSsm);

    expect(mockAsgSend).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({
        Preferences: { MinHealthyPercentage: 0, InstanceWarmup: 60 },
      })}),
    );
  });

  it('reads control-plane/asg-name (scalar) when role is control-plane', async () => {
    const cpEvent = { paramName: '/k8s/development/golden-ami/latest', role: 'control-plane' as const };
    mockSsmSend.mockResolvedValueOnce({ Parameter: { Value: 'asg-control-plane' } });
    mockAsgSend.mockResolvedValueOnce({ InstanceRefreshId: 'refresh-cp' });

    const result = await handler(cpEvent, mockAsg, mockSsm);

    expect(result.refreshIds).toHaveLength(1);
    expect(result.refreshIds[0]).toEqual({ asgName: 'asg-control-plane', refreshId: 'refresh-cp' });
    expect(mockSsmSend).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({
        Name: '/k8s/development/ami-refresh/control-plane/asg-name',
      })}),
    );
  });

  it('returns env and role in result', async () => {
    mockSsmSend.mockResolvedValueOnce({ Parameter: { Value: JSON.stringify(['asg-general']) } });
    mockAsgSend.mockResolvedValueOnce({ InstanceRefreshId: 'refresh-xyz' });

    const result = await handler(event, mockAsg, mockSsm);

    expect(result.env).toBe('development');
    expect(result.role).toBe('workers');
  });

  it('asserts workers SSM path', async () => {
    mockSsmSend.mockResolvedValueOnce({ Parameter: { Value: JSON.stringify(['asg-general']) } });
    mockAsgSend.mockResolvedValueOnce({ InstanceRefreshId: 'refresh-xyz' });

    await handler(event, mockAsg, mockSsm);

    expect(mockSsmSend).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({
        Name: '/k8s/development/ami-refresh/workers/asg-names',
      })}),
    );
  });
});
