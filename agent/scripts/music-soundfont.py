"""Offline instrument rendering through libfluidsynth. No CLI, network or pip.

The owner validates the score and guards this fixed worker. Notes use the same
quantized quarter-note clock as the editable MIDI, with note-offs before ons.
"""
import array
import ctypes as C
import ctypes.util
import json
import math
import os
import sys
import wave


def render(request):
    score = request['score']
    rate, tail = 44100, float(request['releaseTail'])
    seconds = float(score['seconds'])
    if not 0 < seconds <= 120 or not 0 <= tail <= 5 or len(score['tracks']) > 8:
        raise ValueError('Score exceeds instrument render bounds')
    library = ctypes.util.find_library('fluidsynth')
    if not library:
        raise RuntimeError('libfluidsynth is not installed; install it or explicitly choose backend:oscillator')
    lib = C.CDLL(library)
    def api(name, result, *args):
        fn = getattr(lib, name)
        fn.restype, fn.argtypes = result, list(args)
        return fn
    ptr, integer = C.c_void_p, C.c_int
    settings_new = api('new_fluid_settings', ptr)
    settings_num = api('fluid_settings_setnum', integer, ptr, C.c_char_p, C.c_double)
    synth_new = api('new_fluid_synth', ptr, ptr)
    synth_delete = api('delete_fluid_synth', None, ptr)
    settings_delete = api('delete_fluid_settings', None, ptr)
    load = api('fluid_synth_sfload', integer, ptr, C.c_char_p, integer)
    program = api('fluid_synth_program_select', integer, ptr, integer, integer, integer, integer)
    control = api('fluid_synth_cc', integer, ptr, integer, integer, integer)
    on = api('fluid_synth_noteon', integer, ptr, integer, integer, integer)
    off = api('fluid_synth_noteoff', integer, ptr, integer, integer)
    write = api('fluid_synth_write_float', integer, ptr, integer, ptr, integer, integer, ptr, integer, integer)
    settings, synth = settings_new(), None
    if not settings:
        raise RuntimeError('FluidSynth could not allocate settings')
    raw = request['output'] + '.float'
    try:
        settings_num(settings, b'synth.sample-rate', rate)
        settings_num(settings, b'synth.gain', .5)
        synth = synth_new(settings)
        if not synth:
            raise RuntimeError('FluidSynth could not allocate an instrument renderer')
        bank = load(synth, os.fsencode(request['soundfont']), 1)
        if bank < 0:
            raise RuntimeError('SoundFont could not be loaded')
        events = []
        for index, track in enumerate(score['tracks']):
            channel = 9 if track.get('percussion', False) else index
            bank_number = 128 if track.get('percussion', False) else 0
            if program(synth, channel, bank, bank_number, int(track['program'])) < 0:
                raise RuntimeError(f"SoundFont has no bank {bank_number} program {track['program']}")
            if control(synth, channel, 10, round((track['pan'] + 1) * 63.5)) < 0:
                raise RuntimeError('FluidSynth could not apply track pan')
            beat_seconds = score.get('midiTempoMicroseconds', round(60000000 / score['bpm'])) / 1e6
            for note in track['notes']:
                # Match JavaScript/MIDI rounding at exact half-sample ties.
                start = math.floor(note['start'] * beat_seconds * rate + .5)
                end = math.floor((note['start'] + note['duration']) * beat_seconds * rate + .5)
                events.extend([(start, 1, channel, note['pitch'], note['velocity']), (end, 0, channel, note['pitch'], 0)])
        if len(events) > 2048:
            raise ValueError('Too many note events')
        frames = math.ceil((seconds + tail) * rate)
        events.append((frames, -1, 0, 0, 0))
        events.sort()
        left, right = (C.c_float * 1024)(), (C.c_float * 1024)()
        peak, cursor = 0., 0
        with open(raw, 'xb') as output:
            for at, kind, channel, pitch, velocity in events:
                while cursor < at:
                    count = min(1024, at - cursor)
                    if write(synth, count, left, 0, 1, right, 0, 1) < 0:
                        raise RuntimeError('FluidSynth audio rendering failed')
                    samples = array.array('f')
                    for i in range(count):
                        # Keep releases, then a short delivery fade at the tail.
                        fade = min(1., (frames - cursor - i) / (rate * .08))
                        pair = (left[i] * fade, right[i] * fade)
                        if not all(math.isfinite(v) for v in pair):
                            raise RuntimeError('Instrument renderer produced non-finite audio')
                        peak = max(peak, abs(pair[0]), abs(pair[1]))
                        samples.extend(pair)
                    output.write(samples.tobytes())
                    cursor += count
                if kind == 1:
                    if on(synth, channel, pitch, velocity) < 0:
                        raise RuntimeError('FluidSynth could not start a note')
                elif kind == 0:
                    off(synth, channel, pitch)
        gain = min(1., .89 / peak) if peak else 1.
        with open(raw, 'rb') as source, wave.open(request['output'], 'wb') as output:
            output.setparams((2, 2, rate, frames, 'NONE', 'not compressed'))
            while data := source.read(8192 * 4):
                samples = array.array('f'); samples.frombytes(data)
                pcm = array.array('h', (round(max(-1., min(1., v * gain)) * 32767) for v in samples))
                if sys.byteorder != 'little':
                    pcm.byteswap()
                output.writeframesraw(pcm.tobytes())
        return {'backend': 'soundfont', 'channels': 2, 'sampleRate': rate, 'seconds': frames / rate,
                'scoreSeconds': seconds, 'releaseTail': tail, 'previewGain': gain, 'sourcePeak': peak,
                'noteClockToleranceSeconds': 64 / rate}
    finally:
        if synth:
            synth_delete(synth)
        settings_delete(settings)
        if os.path.exists(raw):
            os.unlink(raw)


if __name__ == '__main__':
    with open(sys.argv[1], encoding='utf-8') as file:
        request = json.load(file)
    print('MUSIC_RESULT ' + json.dumps(render(request)), flush=True)
