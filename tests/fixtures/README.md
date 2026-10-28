# Browser audio fixture

`silence.mp3` is 20 seconds of original digital silence, encoded as a valid 44.1 kHz mono MP3 at 64 kbit/s. It contains no song or user recording. The local verification server uses it to test decoding, playback, seeking and offline ranges through the real production handlers.

The byte version is derived from its MD5 checksum. A synthetic sequence of MPEG headers is insufficient for browser decoding tests, so the fixture contains fully encoded frames. LAME's JavaScript encoder was used only as temporary development tooling; it is not an application dependency and is not shipped to Vercel.
