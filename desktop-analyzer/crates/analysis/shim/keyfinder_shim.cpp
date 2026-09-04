// A flat C surface over libkeyfinder's C++ API.
//
// bindgen cannot bind C++ classes usefully, and libkeyfinder's entry point is a
// class method taking a class argument. This shim is the whole of the C++ we
// need: copy samples into an AudioData, run the detector, hand back the key as
// a plain integer.

#include <keyfinder/keyfinder.h>
#include <keyfinder/audiodata.h>

extern "C" {

// Detect the key of a mono or interleaved multi-channel buffer.
//
// Returns a KeyFinder::key_t value (0..=24, where 24 is SILENCE), or -1 if
// libkeyfinder threw. Exceptions must not cross the FFI boundary, so every
// path out of here is a return value.
int kf_key_of_audio(const double *samples,
                    unsigned int sample_count,
                    unsigned int frame_rate,
                    unsigned int channels) {
  if (samples == nullptr || sample_count == 0 || frame_rate == 0 || channels == 0) {
    return -1;
  }
  try {
    KeyFinder::AudioData audio;
    audio.setFrameRate(frame_rate);
    audio.setChannels(channels);
    audio.addToSampleCount(sample_count);
    for (unsigned int i = 0; i < sample_count; i++) {
      audio.setSample(i, samples[i]);
    }

    // A KeyFinder instance caches per-configuration state internally, but is
    // cheap to construct and is not documented as thread-safe, so each call
    // gets its own rather than sharing one across worker threads.
    KeyFinder::KeyFinder detector;
    return static_cast<int>(detector.keyOfAudio(audio));
  } catch (...) {
    return -1;
  }
}

}  // extern "C"
