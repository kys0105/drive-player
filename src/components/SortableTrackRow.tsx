import { ListItem, ListItemButton, ListItemIcon, ListItemText } from '@mui/material';
import { DragIndicator } from '@mui/icons-material';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Track } from '../types';

export function SortableTrackRow({
  track,
  selected,
  onClick,
}: {
  track: Track;
  selected: boolean;
  onClick: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: track.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
    background: selected ? 'rgba(143, 162, 255, 0.15)' : undefined,
    borderRadius: 8,
  } as const;

  return (
    <ListItem ref={setNodeRef} style={style} disablePadding secondaryAction={null}>
      <ListItemButton
        selected={selected}
        onClick={onClick}
        {...attributes}
        {...listeners}
        sx={{ touchAction: 'none', cursor: 'grab' }}
      >
        <ListItemIcon
          sx={{
            minWidth: 40,
            mr: 1,
            color: 'text.secondary',
            pointerEvents: 'none',
          }}
        >
          <DragIndicator />
        </ListItemIcon>
        <ListItemText primary={track.title} secondary={track.artist} />
      </ListItemButton>
    </ListItem>
  );
}
