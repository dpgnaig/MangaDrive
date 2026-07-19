import { useMessenger } from '../../context/MessengerContext'
import ChatWindow from './ChatWindow'
import ChatBubble from './ChatBubble'

const WINDOW_WIDTH = 328
const GAP = 12
const EDGE = 20
const BUBBLE_SIZE = 56
const BUBBLE_GAP = 12

/** Desktop-only container. Expanded windows dock along the bottom; minimized
 *  conversations collapse into a vertical stack of avatar bubbles on the right. */
export default function ChatWindowDock() {
  const { windows } = useMessenger()
  if (windows.length === 0) return null

  const expanded = windows.filter(w => !w.minimized)
  const minimized = windows.filter(w => w.minimized)

  // When any conversation is minimized, reserve a lane on the far right for the
  // vertical bubble stack so expanded windows dock to its left instead of
  // overlapping the bubbles.
  const windowBase = EDGE + (minimized.length > 0 ? BUBBLE_SIZE + BUBBLE_GAP : 0)

  return (
    <div className="dm-dock desktop-only">
      {expanded.map((w, i) => (
        <ChatWindow key={w.id} win={w} offset={windowBase + i * (WINDOW_WIDTH + GAP)} />
      ))}
      {minimized.map((w, i) => (
        <ChatBubble key={w.id} win={w} bottom={EDGE + i * (BUBBLE_SIZE + BUBBLE_GAP)} size={BUBBLE_SIZE} />
      ))}
    </div>
  )
}
