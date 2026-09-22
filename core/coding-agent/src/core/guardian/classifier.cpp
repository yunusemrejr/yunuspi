// Stateless multi-signal Guardian scorer. Feature extraction and task state
// stay in the YunusPi host. Model coefficients and calibration are generated
// offline by scripts/guardian/train-model.mjs from the checked-in labeled
// corpus; no imports, allocator, filesystem, or mutable session state.
#include "model-parameters.generated.h"

using u32 = unsigned int;
using i32 = int;
using i64 = long long;
static u32 g_feature_scratch[12] = {};

static u32 calibrated_probability(i32 logit_milli) {
    // The generated probability knots already contain Platt calibration.
    // Interpolate them against the raw fitted logit exactly once.
    const i32 calibrated = logit_milli;
    if (calibrated <= guardian::kLogitKnotsMilli[0]) return guardian::kProbabilityKnots[0];
    if (calibrated >= guardian::kLogitKnotsMilli[guardian::kKnotCount - 1])
        return guardian::kProbabilityKnots[guardian::kKnotCount - 1];
    for (i32 i = 1; i < guardian::kKnotCount; ++i) {
        if (calibrated > guardian::kLogitKnotsMilli[i]) continue;
        const i32 width = guardian::kLogitKnotsMilli[i] - guardian::kLogitKnotsMilli[i - 1];
        const i32 offset = calibrated - guardian::kLogitKnotsMilli[i - 1];
        const i64 rise = static_cast<i64>(guardian::kProbabilityKnots[i] - guardian::kProbabilityKnots[i - 1]) * offset;
        return guardian::kProbabilityKnots[i - 1] + static_cast<u32>(rise / width);
    }
    return 0;
}

extern "C" __attribute__((visibility("default"))) u32 guardian_eval(
    u32 feature_ptr, u32 feature_count, u32 category) {
    if (feature_count != guardian::kFeatureCount || category != 0 || feature_ptr != static_cast<u32>(reinterpret_cast<unsigned long>(g_feature_scratch))) return 0;
    const u32* features = reinterpret_cast<const u32*>(static_cast<unsigned long>(feature_ptr));

    // Required independent event evidence for repeated ineffective operations:
    // multiple failures, near-identical inputs, observed result turns, a live
    // task, fresh activity, and no explicit user override. These are safety
    // gates; learned weights rank only candidates that satisfy every gate.
    for (u32 i = 0; i < guardian::kFeatureCount; ++i) {
        const u32 value = features[i];
        if (value > 1000) return 0;
        if (value < guardian::kMinimumEvidence[i]) return 0;
    }

    i64 total = static_cast<i64>(guardian::kBiasMilli) * 1000;
    for (u32 i = 0; i < guardian::kFeatureCount; ++i) {
        const u32 value = features[i];
        if (value > 1000) return 0;
        total += static_cast<i64>(guardian::kWeightsMilli[i]) * value;
    }
    const i64 scaled = total / 1000;
    const i32 logit = scaled < -20000 ? -20000 : scaled > 20000 ? 20000 : static_cast<i32>(scaled);
    return calibrated_probability(logit);
}

extern "C" __attribute__((visibility("default"))) u32 guardian_model_version() { return guardian::kModelVersion; }
extern "C" __attribute__((visibility("default"))) u32 guardian_feature_count() { return guardian::kFeatureCount; }
extern "C" __attribute__((visibility("default"))) u32 guardian_threshold() { return guardian::kConfidenceThreshold; }
extern "C" __attribute__((visibility("default"))) u32 guardian_feature_buffer_ptr() {
    return static_cast<u32>(reinterpret_cast<unsigned long>(g_feature_scratch));
}
