import {
  AutoScalingClient,
  StartInstanceRefreshCommand,
} from '@aws-sdk/client-auto-scaling';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

const asg = new AutoScalingClient({});
const ssm = new SSMClient({});

export interface StartInstanceRefreshEvent {
  paramName: string;
  role: 'workers' | 'control-plane';
}

export interface StartInstanceRefreshResult {
  role: string;
  env: string;
  refreshIds: Array<{ asgName: string; refreshId: string }>;
}

export async function handler(
  event: StartInstanceRefreshEvent,
): Promise<StartInstanceRefreshResult> {
  const env = event.paramName.split('/')[2];
  if (!env) throw new Error(`Cannot extract env from paramName: ${event.paramName}`);

  const asgNames = await getAsgNames(env, event.role);

  const refreshIds: Array<{ asgName: string; refreshId: string }> = [];
  for (const asgName of asgNames) {
    const resp = await asg.send(new StartInstanceRefreshCommand({
      AutoScalingGroupName: asgName,
      Preferences: {
        // 50%: at most half the pool is in-flight at once. With min=1
        // / max=4 this means 1 instance at a time on the general pool,
        // which gives NTH room to drain before the next termination
        // fires. 0% (the previous default) let the ASG kill 100% of
        // the pool simultaneously — incompatible with PDB-respecting
        // drains.
        MinHealthyPercentage: 50,
        // 300s: covers kubeadm join + Calico ready + system pods +
        // Traefik scheduled before InstanceRefresh starts the next
        // termination. The previous 60s was shorter than the boot
        // path, so refresh would routinely outpace the cluster's
        // ability to absorb the new node.
        InstanceWarmup: 300,
      },
    }));
    const refreshId = resp.InstanceRefreshId;
    if (!refreshId) throw new Error(`StartInstanceRefresh returned no InstanceRefreshId for ${asgName}`);
    refreshIds.push({ asgName, refreshId });
  }

  return { role: event.role, env, refreshIds };
}

async function getAsgNames(env: string, role: string): Promise<string[]> {
  if (role === 'workers') {
    const p = await ssm.send(
      new GetParameterCommand({ Name: `/k8s/${env}/ami-refresh/workers/asg-names` }),
    );
    const val = p.Parameter?.Value;
    if (!val) throw new Error(`SSM parameter /k8s/${env}/ami-refresh/workers/asg-names has no value`);
    const parsed: unknown = JSON.parse(val);
    if (!Array.isArray(parsed) || parsed.length === 0 || typeof parsed[0] !== 'string') {
      throw new Error(`SSM parameter /k8s/${env}/ami-refresh/workers/asg-names must be a non-empty JSON string array`);
    }
    return parsed as string[];
  }
  const p = await ssm.send(
    new GetParameterCommand({ Name: `/k8s/${env}/ami-refresh/control-plane/asg-name` }),
  );
  const val = p.Parameter?.Value;
  if (!val) throw new Error(`SSM parameter /k8s/${env}/ami-refresh/control-plane/asg-name has no value`);
  return [val];
}
