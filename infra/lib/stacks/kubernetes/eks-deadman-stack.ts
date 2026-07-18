/**
 * EKS Dead-Man's-Switch Stack — external liveness watch for Prometheus.
 *
 * Why this exists: on 2026-07-17 Prometheus crashlooped for ~22 hours
 * (prometheus-data PVC full, "preallocate: no space left on device") and
 * NOTHING paged — every alert rule in the platform evaluates *inside*
 * Prometheus, so its own death is invisible to the alerting layer. This
 * stack is the watcher outside the system:
 *
 *   Route53 HealthCheck (worldwide checkers, HTTPS)
 *     └─ GET https://ops.nelsonlamounier.com/prometheus/-/healthy
 *          └─ ALB → WAF (path is IP-allowlist exempt) → prometheus-auth-proxy
 *             nginx (exact-match location, no basic-auth) → Prometheus
 *   CloudWatch Alarm on HealthCheckStatus < 1  →  SNS e-mail
 *
 * Region: MUST deploy to us-east-1 — Route53 health checks publish their
 * CloudWatch metrics only there, and an alarm can only notify an SNS topic
 * in its own region. The factory pins `env.region` accordingly; nothing in
 * here references eu-west-1 resources (no cross-region refs needed).
 *
 * Failure semantics: 200 from Prometheus ⇒ healthy. Prometheus dead ⇒ nginx
 * returns 502 ⇒ unhealthy. ALB/WAF/nginx dead ⇒ connection failure ⇒
 * unhealthy. Missing metric data is treated as BREACHING so a deleted or
 * misconfigured health check also alarms instead of going silently green.
 */

import * as cdk from 'aws-cdk-lib/core';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

export interface EksDeadmanStackProps extends cdk.StackProps {
    /** Environment name used in resource descriptions (e.g. `development`). */
    readonly targetEnvironment: string;
    /** Host serving the monitored endpoint (e.g. `ops.nelsonlamounier.com`). */
    readonly monitoredHost: string;
    /**
     * HTTPS path probed by the health check. Must be reachable WITHOUT
     * authentication and WITHOUT an IP allowlist (Route53 checkers come from
     * global IPs) — see the WAF `ipAllowlistExemptPaths` entry and the
     * auth-proxy nginx exact-match location that together make
     * `/prometheus/-/healthy` a true pass-through to Prometheus.
     */
    readonly monitoredPath: string;
    /**
     * E-mail for alarm notifications. Optional so synth never fails in CI;
     * follows the same `NOTIFICATION_EMAIL` convention as the FinOps stack.
     * Without it the alarm still exists (visible in the console / usable by
     * future subscribers) but pages nobody.
     */
    readonly notificationEmail?: string;
}

export class EksDeadmanStack extends cdk.Stack {
    /** Topic the dead-man alarm publishes to (us-east-1). */
    public readonly alarmTopic: sns.Topic;

    constructor(scope: Construct, id: string, props: EksDeadmanStackProps) {
        super(scope, id, props);

        // L1 CfnHealthCheck — the L2 HealthCheck construct does not yet
        // cover CALCULATED/alarm wiring cleanly and adds nothing here.
        const healthCheck = new route53.CfnHealthCheck(this, 'PrometheusHealthCheck', {
            healthCheckConfig: {
                type: 'HTTPS',
                fullyQualifiedDomainName: props.monitoredHost,
                resourcePath: props.monitoredPath,
                port: 443,
                // 30s × 3 failures ⇒ alarm raw signal within ~90s of death;
                // evaluation below adds ~3 min to page. The 22h outage this
                // guards against makes minutes-scale detection ample.
                requestInterval: 30,
                failureThreshold: 3,
                enableSni: true,
                measureLatency: false,
            },
        });
        cdk.Tags.of(healthCheck).add(
            'Name',
            `prometheus-deadman-${props.targetEnvironment}`,
        );

        this.alarmTopic = new sns.Topic(this, 'DeadmanAlarmTopic', {
            displayName: `Prometheus dead-man switch (${props.targetEnvironment})`,
        });
        if (props.notificationEmail) {
            this.alarmTopic.addSubscription(
                new subscriptions.EmailSubscription(props.notificationEmail),
            );
        }

        const alarm = new cloudwatch.Alarm(this, 'PrometheusDeadmanAlarm', {
            alarmName: `prometheus-deadman-${props.targetEnvironment}`,
            alarmDescription:
                `Prometheus liveness probe failing at https://${props.monitoredHost}` +
                `${props.monitoredPath} — the in-cluster alerting layer is blind ` +
                'while this fires. Check the prometheus pod in the monitoring ' +
                'namespace first (2026-07 incident: PVC full → WAL-replay crashloop).',
            metric: new cloudwatch.Metric({
                namespace: 'AWS/Route53',
                metricName: 'HealthCheckStatus',
                dimensionsMap: { HealthCheckId: healthCheck.attrHealthCheckId },
                statistic: 'Minimum',
                period: cdk.Duration.minutes(1),
            }),
            comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
            threshold: 1,
            evaluationPeriods: 3,
            // A silent/missing metric must page too — a deleted health check
            // or region mixup would otherwise look permanently healthy.
            treatMissingData: cloudwatch.TreatMissingData.BREACHING,
        });
        alarm.addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));
        alarm.addOkAction(new cloudwatchActions.SnsAction(this.alarmTopic));

        new cdk.CfnOutput(this, 'HealthCheckId', {
            value: healthCheck.attrHealthCheckId,
            description: 'Route53 health check watching Prometheus liveness',
        });
        new cdk.CfnOutput(this, 'DeadmanTopicArn', {
            value: this.alarmTopic.topicArn,
            description: 'SNS topic (us-east-1) the dead-man alarm notifies',
        });
    }
}
