// Conservative byte n-gram similarity kernel for short, sanitized template
// identities and verified spans. This is a corroborating signal only; it
// cannot trigger an intervention by itself.

using u32 = unsigned int;
static unsigned char g_left_scratch[512] = {};
static unsigned char g_right_scratch[512] = {};

static u32 gram_count(const unsigned char* bytes, u32 length, u32 out[512]) {
    if (length < 3) return 0;
    u32 count = 0;
    for (u32 i = 0; i + 2 < length && count < 512; ++i) {
        const unsigned char a = bytes[i] >= 'A' && bytes[i] <= 'Z' ? bytes[i] + 32 : bytes[i];
        const unsigned char b = bytes[i + 1] >= 'A' && bytes[i + 1] <= 'Z' ? bytes[i + 1] + 32 : bytes[i + 1];
        const unsigned char c = bytes[i + 2] >= 'A' && bytes[i + 2] <= 'Z' ? bytes[i + 2] + 32 : bytes[i + 2];
        if (a == ' ' || b == ' ' || c == ' ') continue;
        out[count++] = (static_cast<u32>(a) << 16) | (static_cast<u32>(b) << 8) | c;
    }
    return count;
}

extern "C" __attribute__((visibility("default"))) u32 guardian_similarity(
    u32 left_ptr, u32 left_length, u32 right_ptr, u32 right_length) {
    if (left_ptr != static_cast<u32>(reinterpret_cast<unsigned long>(g_left_scratch)) ||
        right_ptr != static_cast<u32>(reinterpret_cast<unsigned long>(g_right_scratch)) ||
        left_length > sizeof(g_left_scratch) || right_length > sizeof(g_right_scratch)) return 0;
    const unsigned char* left = reinterpret_cast<const unsigned char*>(static_cast<unsigned long>(left_ptr));
    const unsigned char* right = reinterpret_cast<const unsigned char*>(static_cast<unsigned long>(right_ptr));
    u32 left_grams[512] = {};
    u32 right_grams[512] = {};
    const u32 left_count = gram_count(left, left_length, left_grams);
    const u32 right_count = gram_count(right, right_length, right_grams);
    if (left_count == 0 || right_count == 0) return 0;

    // Greedy multiset overlap, bounded by the fixed 512-gram scratch arrays.
    unsigned char matched[512] = {};
    u32 overlap = 0;
    for (u32 i = 0; i < left_count; ++i) {
        for (u32 j = 0; j < right_count; ++j) {
            if (!matched[j] && left_grams[i] == right_grams[j]) {
                matched[j] = 1;
                ++overlap;
                break;
            }
        }
    }
    return (2000u * overlap) / (left_count + right_count); // Dice score × 1000
}

extern "C" __attribute__((visibility("default"))) u32 guardian_similarity_version() { return 1; }
extern "C" __attribute__((visibility("default"))) u32 guardian_similarity_left_ptr() {
    return static_cast<u32>(reinterpret_cast<unsigned long>(g_left_scratch));
}
extern "C" __attribute__((visibility("default"))) u32 guardian_similarity_right_ptr() {
    return static_cast<u32>(reinterpret_cast<unsigned long>(g_right_scratch));
}
