import type { EC2Client } from '@aws-sdk/client-ec2';
import type { SSMClient } from '@aws-sdk/client-ssm';
import { handler } from '../../../../lib/constructs/events/ami-refresh/handlers/update-launch-template';

const mockEc2Send = jest.fn();
const mockSsmSend = jest.fn();
const mockEc2 = { send: mockEc2Send } as unknown as EC2Client;
const mockSsm = { send: mockSsmSend } as unknown as SSMClient;

beforeEach(() => {
  mockEc2Send.mockReset();
  mockSsmSend.mockReset();
});

describe('update-launch-template', () => {
  const event = { paramName: '/k8s/development/golden-ami/latest', role: 'workers' as const };

  it('reads AMI ID from the paramName SSM parameter', async () => {
    // SSM call 1: GetParameter(paramName) → amiId
    mockSsmSend.mockResolvedValueOnce({ Parameter: { Value: 'ami-0newimage123' } });
    // SSM call 2: GetParameter(lt-ids)
    mockSsmSend.mockResolvedValueOnce({ Parameter: { Value: JSON.stringify(['lt-abc123']) } });
    // EC2 call 1: CreateLaunchTemplateVersion
    mockEc2Send.mockResolvedValueOnce({ LaunchTemplateVersion: { VersionNumber: 5 } });
    // EC2 call 2: ModifyLaunchTemplate
    mockEc2Send.mockResolvedValueOnce({});

    const result = await handler(event, mockEc2, mockSsm);

    expect(result.amiId).toBe('ami-0newimage123');
    expect(result.env).toBe('development');
    expect(result.role).toBe('workers');
    expect(mockSsmSend).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({
        Name: '/k8s/development/ami-refresh/workers/lt-ids',
      })}),
    );
  });

  it('creates a new LT version with the new AMI ID', async () => {
    mockSsmSend
      .mockResolvedValueOnce({ Parameter: { Value: 'ami-0newimage123' } })
      .mockResolvedValueOnce({ Parameter: { Value: JSON.stringify(['lt-abc123']) } });
    mockEc2Send
      .mockResolvedValueOnce({ LaunchTemplateVersion: { VersionNumber: 7 } })
      .mockResolvedValueOnce({});

    await handler(event, mockEc2, mockSsm);

    expect(mockEc2Send).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({
        LaunchTemplateId: 'lt-abc123',
        SourceVersion: '$Latest',
        LaunchTemplateData: { ImageId: 'ami-0newimage123' },
      })}),
    );
  });

  it('sets the new version as the LT default', async () => {
    mockSsmSend
      .mockResolvedValueOnce({ Parameter: { Value: 'ami-0newimage123' } })
      .mockResolvedValueOnce({ Parameter: { Value: JSON.stringify(['lt-abc123']) } });
    mockEc2Send
      .mockResolvedValueOnce({ LaunchTemplateVersion: { VersionNumber: 7 } })
      .mockResolvedValueOnce({});

    await handler(event, mockEc2, mockSsm);

    expect(mockEc2Send).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({
        LaunchTemplateId: 'lt-abc123',
        DefaultVersion: '7',
      })}),
    );
  });

  it('updates all LTs in the worker pool', async () => {
    const ltIds = ['lt-111', 'lt-222'];
    mockSsmSend
      .mockResolvedValueOnce({ Parameter: { Value: 'ami-0newimage123' } })
      .mockResolvedValueOnce({ Parameter: { Value: JSON.stringify(ltIds) } });
    mockEc2Send
      .mockResolvedValueOnce({ LaunchTemplateVersion: { VersionNumber: 3 } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ LaunchTemplateVersion: { VersionNumber: 3 } })
      .mockResolvedValueOnce({});

    await handler(event, mockEc2, mockSsm);

    const createCalls = mockEc2Send.mock.calls.filter(([cmd]) =>
      cmd.constructor?.name === 'CreateLaunchTemplateVersionCommand',
    );
    expect(createCalls).toHaveLength(2);
    const callOrder = mockEc2Send.mock.calls.map(([cmd]) => cmd.constructor?.name);
    expect(callOrder).toEqual([
      'CreateLaunchTemplateVersionCommand',
      'ModifyLaunchTemplateCommand',
      'CreateLaunchTemplateVersionCommand',
      'ModifyLaunchTemplateCommand',
    ]);
  });

  it('reads control-plane/lt-id (not array) when role is control-plane', async () => {
    const cpEvent = { paramName: '/k8s/development/golden-ami/latest', role: 'control-plane' as const };
    mockSsmSend
      .mockResolvedValueOnce({ Parameter: { Value: 'ami-0newimage123' } })
      .mockResolvedValueOnce({ Parameter: { Value: 'lt-cp-999' } });
    mockEc2Send
      .mockResolvedValueOnce({ LaunchTemplateVersion: { VersionNumber: 2 } })
      .mockResolvedValueOnce({});

    await handler(cpEvent, mockEc2, mockSsm);

    expect(mockSsmSend).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({
        Name: '/k8s/development/ami-refresh/control-plane/lt-id',
      })}),
    );
  });
});
