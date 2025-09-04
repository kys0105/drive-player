// src/components/TrackList.tsx
import { Card, CardContent, List } from '@mui/material';
import { DndContext, closestCenter, type DragEndEvent, type SensorDescriptor } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { Track } from '../types';
import { SortableTrackRow } from './SortableTrackRow';

const CONTENT_MAX_W = 560;

type Props = {
  tracks: Track[];
  index: number;
  setIndex: (i: number) => void;
  sensors: SensorDescriptor<unknown>[];
  handleDragEnd: (e: DragEndEvent) => void;
  loadingById: Record<string, boolean>;
};

export function TrackList({
  tracks,
  index,
  setIndex,
  sensors,
  handleDragEnd,
  loadingById,
}: Props) {
  return (
    <Card sx={{ width: '100%', maxWidth: CONTENT_MAX_W }}>
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

