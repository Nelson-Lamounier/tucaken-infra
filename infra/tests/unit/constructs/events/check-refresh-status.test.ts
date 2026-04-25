import type { AutoScalingClient } from '@aws-sdk/client-auto-scaling';
import type { SSMClient } from '@aws-sdk/client-ssm';
import { handler } from '../../../../lib/constructs/events/ami-refresh/handlers/check-refresh-status';

const mockSend = jest.fn();

const mockSsm = { send: mockSend } as unknown as SSMClient;
const mockAsg = { send: mockSend } as unknown as AutoScalingClient;

beforeEach(() => mockSend.mockReset());

describe('check-refresh-status', () => {
  const event = { paramName: '/k8s/development/golden-ami/latest', role: 'workers' as const };

  it('returns COMPLETE when all ASG refreshes are Successful', async () => {
    // First call: SSM GetParameter for asg-names
    mockSend.mockResolvedValueOnce({
      Parameter: { Value: JSON.stringify(['k8s-development-general-asg']) },
    });
    // Second call: DescribeInstanceRefreshes
    mockSend.mockResolvedValueOnce({
      InstanceRefreshes: [{
        Status: 'Successful',
        StartTime: new Date(Date.now() - 5 * 60 * 1000), // 5 min ago
      }],
    });

    const result = await handler(event, mockAsg, mockSsm);
    expect(result).toEqual({ status: 'COMPLETE', detail: null });
  });

  it('returns IN_PROGRESS when a refresh is still running', async () => {
    mockSend.mockResolvedValueOnce({
      Parameter: { Value: JSON.stringify(['k8s-development-general-asg']) },
    });
    mockSend.mockResolvedValueOnce({
      InstanceRefreshes: [{
        Status: 'InProgress',
        StartTime: new Date(Date.now() - 2 * 60 * 1000),
      }],
    });

    const result = await handler(event, mockAsg, mockSsm);
    expect(result.status).toBe('IN_PROGRESS');
  });

  it('returns FAILED when a refresh has Failed status', async () => {
    mockSend.mockResolvedValueOnce({
      Parameter: { Value: JSON.stringify(['k8s-development-general-asg']) },
    });
    mockSend.mockResolvedValueOnce({
      InstanceRefreshes: [{
        Status: 'Failed',
        StatusReason: 'Launch template invalid',
        StartTime: new Date(Date.now() - 3 * 60 * 1000),
      }],
    });

    const result = await handler(event, mockAsg, mockSsm);
    expect(result.status).toBe('FAILED');
    expect(result.detail).toContain('Failed');
  });

  it('returns FAILED when a refresh has Cancelled status', async () => {
    mockSend.mockResolvedValueOnce({
      Parameter: { Value: JSON.stringify(['k8s-development-general-asg']) },
    });
    mockSend.mockResolvedValueOnce({
      InstanceRefreshes: [{
        Status: 'Cancelled',
        StatusReason: 'User cancelled',
        StartTime: new Date(Date.now() - 3 * 60 * 1000),
      }],
    });

    const result = await handler(event, mockAsg, mockSsm);
    expect(result.status).toBe('FAILED');
    expect(result.detail).toContain('Cancelled');
  });

  it('returns FAILED when a refresh has RollbackFailed status', async () => {
    mockSend.mockResolvedValueOnce({
      Parameter: { Value: JSON.stringify(['k8s-development-general-asg']) },
    });
    mockSend.mockResolvedValueOnce({
      InstanceRefreshes: [{
        Status: 'RollbackFailed',
        StatusReason: 'Rollback failed',
        StartTime: new Date(Date.now() - 10 * 60 * 1000),
      }],
    });

    const result = await handler(event, mockAsg, mockSsm);
    expect(result.status).toBe('FAILED');
    expect(result.detail).toContain('RollbackFailed');
  });

  it('returns FAILED when refresh exceeds MAX_WAIT_MINUTES', async () => {
    mockSend.mockResolvedValueOnce({
      Parameter: { Value: JSON.stringify(['k8s-development-general-asg']) },
    });
    mockSend.mockResolvedValueOnce({
      InstanceRefreshes: [{
        Status: 'InProgress',
        StartTime: new Date(Date.now() - 45 * 60 * 1000), // 45 min ago, over 40 min limit
      }],
    });

    const result = await handler(event, mockAsg, mockSsm);
    expect(result.status).toBe('FAILED');
    expect(result.detail).toContain('timed out');
  });

  it('reads control-plane/asg-name (not array) when role is control-plane', async () => {
    const cpEvent = { paramName: '/k8s/development/golden-ami/latest', role: 'control-plane' as const };
    mockSend.mockResolvedValueOnce({
      Parameter: { Value: 'k8s-development-control-plane-asg' },
    });
    mockSend.mockResolvedValueOnce({
      InstanceRefreshes: [{ Status: 'Successful', StartTime: new Date() }],
    });

    const result = await handler(cpEvent, mockAsg, mockSsm);
    expect(result.status).toBe('COMPLETE');
    // Verify SSM was called with control-plane path
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({
        Name: '/k8s/development/ami-refresh/control-plane/asg-name',
      })}),
    );
  });
});
