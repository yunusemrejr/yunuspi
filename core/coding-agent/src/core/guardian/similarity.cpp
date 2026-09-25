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

// In-place heapsort bounds worst-case work to O(n log n), including
// unrelated 512-byte inputs. No allocator, imports, or shared mutable state.
static void sift_down(u32* values, u32 root, u32 count) {
    while (root * 2 + 1 < count) {
        u32 child = root * 2 + 1;
        if (child + 1 < count && values[child] < values[child + 1]) ++child;
        if (values[root] >= values[child]) return;
        const u32 value = values[root]; values[root] = values[child]; values[child] = value;
        root = child;
    }
}
static void sort_grams(u32* values, u32 count) {
    for (u32 i = count / 2; i > 0; --i) sift_down(values, i - 1, count);
    for (u32 end = count; end > 1; --end) {
        const u32 value = values[0]; values[0] = values[end - 1]; values[end - 1] = value;
        sift_down(values, 0, end - 1);
    }
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

    // Identical normalized shapes are the common supervision path.
    bool identical = left_count == right_count;
    if (identical) {
        for (u32 i = 0; i < left_count; ++i) {
            if (left_grams[i] != right_grams[i]) { identical = false; break; }
        }
        if (identical) return 1000;
    }
    sort_grams(left_grams, left_count);
    sort_grams(right_grams, right_count);
    u32 overlap = 0, i = 0, j = 0;
    while (i < left_count && j < right_count) {
        if (left_grams[i] == right_grams[j]) { ++overlap; ++i; ++j; }
        else if (left_grams[i] < right_grams[j]) ++i;
        else ++j;
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
