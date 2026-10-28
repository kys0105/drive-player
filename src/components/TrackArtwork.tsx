import { useState } from 'react';
import type { ImgHTMLAttributes } from 'react';
import type { Track } from '../types';
import { artwork, fallbackArtwork } from './music';

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'srcSet'> & { track?: Track; retryKey?: string };

/** Authenticated same-origin images; a missing Drive image keeps the layout intact. */
export default function TrackArtwork({ track, retryKey = '', alt = '', onError, ...props }: Props) {
  const source = artwork(track);
  const requestKey = `${retryKey}:${source}`;
  const [failedSource, setFailedSource] = useState('');
  return <img {...props} alt={alt} src={failedSource === requestKey ? fallbackArtwork : source}
    onError={event => { if (source !== fallbackArtwork) setFailedSource(requestKey); onError?.(event); }} />;
}
