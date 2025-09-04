// src/components/SortableTrackRow.tsx
import { ListItem, ListItemButton, ListItemText, Box, CircularProgress } from '@mui/material';
import { DragIndicator } from '@mui/icons-material';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Track } from '../types';

type Props = {
  track: Track;
  selected: boolean;
  onClick: () => void;
  loading?: boolean;
};

export function SortableTrackRow({ track, selected, onClick, loading = false }: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: track.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 1 : undefined,
    position: 'relative' as const,
  };

  return (
    <ListItem ref={setNodeRef} disablePadding sx={style}>
      <ListItemButton
        selected={selected}
        onClick={onClick}
        {...attributes}
        {...listeners}
        sx={{
          pr: 1.5,
          gap: 1,
          opacity: isDragging ? 0.9 : 1,
        }}
      >
        <ListItemText primary={track.title} secondary={track.artist} />

        {/* 右端：読み込み中インジケーター + ドラッグアイコン */}
        <Box
          sx={{
            ml: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 0.75,
          }}
        >
          {loading && <CircularProgress size={16} thickness={5} />}

          <DragIndicator
            fontSize="small"
            sx={{
              color: 'text.secondary',
              pointerEvents: 'none', // アイコンでのクリックを拾わない
              opacity: 0.8,
            }}
          />
        </Box>
      </ListItemButton>
    </ListItem>
  );
}
