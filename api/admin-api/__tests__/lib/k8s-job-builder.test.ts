import { traceParentEnv } from '../../src/lib/k8s-job-builder.js';

describe('traceParentEnv', () => {
    it('returns null when there is no active span', () => {
        // No OTel SDK running in tests → propagation is a no-op → no traceparent header
        expect(traceParentEnv()).toBeNull();
    });
});
