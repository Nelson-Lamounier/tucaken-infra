import {
  AutoScalingClient,
  DescribeInstanceRefreshesCommand,
} from '@aws-sdk/client-auto-scaling';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

export interface CheckRefreshStatusEvent {
  paramName: string;
  role: 'workers' | 'control-plane';
}

export type RefreshStatus = 'COMPLETE' | 'IN_PROGRESS' | 'FAILED';

export interface CheckRefreshStatusResult {
  status: RefreshStatus;
  detail: string | null;
}

const MAX_WAIT_MINUTES = Number(process.env.MAX_WAIT_MINUTES ?? '40');

export async function handler(
  event: CheckRefreshStatusEvent,
  asgClient: AutoScalingClient = new AutoScalingClient({}),
  ssmClient: SSMClient = new SSMClient({}),
): Promise<CheckRefreshStatusResult> {
  const env = event.paramName.split('/')[2];
  const asgNames = await getAsgNames(env, event.role, ssmClient);
  const statuses = await Promise.all(asgNames.map(name => checkAsg(name, asgClient)));

  const failed = statuses.find(s => s.status === 'FAILED');
  if (failed) return { status: 'FAILED', detail: failed.detail };
  if (statuses.every(s => s.status === 'COMPLETE')) return { status: 'COMPLETE', detail: null };
  return { status: 'IN_PROGRESS', detail: null };
}

async function checkAsg(
  asgName: string,
  asgClient: AutoScalingClient,
): Promise<CheckRefreshStatusResult> {
  const resp = await asgClient.send(
    new DescribeInstanceRefreshesCommand({ AutoScalingGroupName: asgName }),
  );
  const refresh = resp.InstanceRefreshes?.[0];
  if (!refresh) return { status: 'FAILED', detail: `No refresh found for ${asgName}` };

  const elapsedMin = (Date.now() - new Date(refresh.StartTime!).getTime()) / 60_000;
  if (elapsedMin > MAX_WAIT_MINUTES) {
    return {
      status: 'FAILED',
      detail: `Refresh on ${asgName} timed out after ${Math.round(elapsedMin)} min`,
    };
  }

  if (['Failed', 'Cancelled', 'RollbackFailed'].includes(refresh.Status!)) {
    return {
      status: 'FAILED',
      detail: `${asgName}: ${refresh.Status} — ${refresh.StatusReason ?? 'no reason given'}`,
    };
  }
  if (refresh.Status === 'Successful') return { status: 'COMPLETE', detail: null };
  return { status: 'IN_PROGRESS', detail: null };
}

async function getAsgNames(
  env: string,
  role: string,
  ssmClient: SSMClient,
): Promise<string[]> {
  if (role === 'workers') {
    const p = await ssmClient.send(
      new GetParameterCommand({ Name: `/k8s/${env}/ami-refresh/workers/asg-names` }),
    );
    return JSON.parse(p.Parameter!.Value!);
  }
  const p = await ssmClient.send(
    new GetParameterCommand({ Name: `/k8s/${env}/ami-refresh/control-plane/asg-name` }),
  );
  return [p.Parameter!.Value!];
}
