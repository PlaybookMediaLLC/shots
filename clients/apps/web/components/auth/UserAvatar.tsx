import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'

/** The signed-in person's identity; workspace marks remain square and separately labelled. */
export function UserAvatar({ name, image, className }: { name: string; image?: string | null; className?: string }) {
  return (
    <Avatar aria-hidden className={cn('size-8', className)}>
      {image ? <AvatarImage alt="" className="object-cover" src={image} /> : null}
      <AvatarFallback name={name.trim() || '?'} />
    </Avatar>
  )
}
