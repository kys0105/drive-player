import {
  PlayIcon, PauseIcon, SkipBackIcon, SkipForwardIcon, MusicNotesIcon,
  DownloadSimpleIcon, CheckCircleIcon, DotsThreeIcon, GearIcon,
  MagnifyingGlassIcon, CaretDownIcon, XIcon, RepeatIcon, RepeatOnceIcon,
  QueueIcon, ChatTextIcon, ArrowUpIcon, ArrowDownIcon, UploadSimpleIcon,
  SpinnerGapIcon, WifiSlashIcon, ArrowCounterClockwiseIcon, ListNumbersIcon,
} from '@phosphor-icons/react';

const icons = {
  play: PlayIcon, pause: PauseIcon, previous: SkipBackIcon, next: SkipForwardIcon,
  music: MusicNotesIcon, download: DownloadSimpleIcon, saved: CheckCircleIcon,
  more: DotsThreeIcon, settings: GearIcon, search: MagnifyingGlassIcon,
  down: CaretDownIcon, close: XIcon, repeat: RepeatIcon, repeatOne: RepeatOnceIcon,
  queue: QueueIcon, lyrics: ChatTextIcon, up: ArrowUpIcon, moveDown: ArrowDownIcon,
  upload: UploadSimpleIcon, loading: SpinnerGapIcon, offline: WifiSlashIcon,
  restart: ArrowCounterClockwiseIcon, order: ListNumbersIcon,
};
export type IconName = keyof typeof icons;
export function Icon({name,size=24,fill=false,className=''}:{name:IconName;size?:number;fill?:boolean;className?:string}) {
  const Component=icons[name];
  return <Component size={size} weight={fill?'fill':'regular'} className={className} aria-hidden="true" />;
}
