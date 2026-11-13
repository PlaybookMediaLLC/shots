# E2E fixtures

- `portrait-public-domain.jpg`: Abraham Lincoln, matte collodion print (O-77) by Alexander
  Gardner, 1863. Public domain (published before 1929). Source:
  https://commons.wikimedia.org/wiki/File:Abraham_Lincoln_O-77_matte_collodion_print.jpg
  Used to check that face detection finds a face to redact.
- `tone.wav`: 2 seconds of a 440 Hz sine, 22.05 kHz mono 16-bit PCM, generated in code. Used to
  check that audio is imported, played on the timeline, and muxed into MP4 exports.
- `music-10s.mp3`: 4 seconds of silence, then 6 seconds of a 330 Hz sine, 22.05 kHz mono MP3,
  generated with FFmpeg. A render has sound only when it starts the track at the trimmed 4 seconds.
- `ugc-clip.mp4`, `ugc-closing.mp4`, `ugc-short.mp4`: FFmpeg test patterns (`testsrc2`, `testsrc`)
  as H.264 MP4s: a 3-second 360×640 30 fps clip with a sine tone, a 4-second 640×360 25 fps clip
  with a tone, and a silent 2-second clip. Used to check UGC rendering, mixed sizes and frame rates,
  and the closing clip's length limits.
