// src/components/Playlist.tsx
import { Card, CardContent, List } from '@mui/material';
import {
  DndContext,
  closestCenter,
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { SortableTrackRow } from './SortableTrackRow';
import type { Track } from '../types';

type Props = {
  tracks: Track[];
  index: number;
  setIndex: (i: number) => void;
  handleDragEnd: (e: DragEndEvent) => void;
  loadingById: Record<string, boolean>;
  maxWidth: number;
};

export function Playlist({ tracks, index, setIndex, handleDragEnd, loadingById, maxWidth }: Props) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor)
  );

  return (
    <Card sx={{ width: '100%', maxWidth }}>
      <CardContent>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={tracks.map((x) => x.id)} strategy={verticalListSortingStrategy}>
            <List>
              {tracks.map((x, i) => (
                <SortableTrackRow
                  key={x.id}
                  track={x}
                  selected={i === index}
                  onClick={() => setIndex(i)}
                  loading={!!loadingById[x.id]}
                />
              ))}
            </List>
          </SortableContext>
        </DndContext>
      </CardContent>
    </Card>
  );
}

export default Playlist;
