// src/components/Playlist.tsx
import { Card, CardContent, CardHeader, List, Button, Box } from '@mui/material';
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
  onYumoshinOrder: () => void;
};

export function Playlist({
  tracks,
  index,
  setIndex,
  handleDragEnd,
  loadingById,
  maxWidth,
  onYumoshinOrder,
}: Props) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor)
  );

  return (
    <Card sx={{ width: '100%', maxWidth }}>
      <CardHeader
        // タイトルを出さないなら空Boxで高さだけ確保
        title={<Box />}
        action={
          <Button
            onClick={onYumoshinOrder}
            size="small"
            variant="outlined"
            sx={{ fontSize: '0.6rem', minWidth: 0, px: 1, py: 0.5, mr: 1 }}
          >
            ゆもしんが考えた曲順になるボタン
          </Button>
        }
        sx={{ pb: 0 }} // ヘッダー下の余白を少し詰める
      />
      <CardContent>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={tracks.map((x) => x.id)} strategy={verticalListSortingStrategy}>
            <List sx={{ pt: 0 }}>
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
