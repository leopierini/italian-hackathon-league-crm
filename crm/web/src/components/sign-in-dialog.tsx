import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { AccessTokenForm } from "@/pages/login"

export function SignInDialog({
  open,
  onOpenChange,
  onSuccess,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-sm">
        <SheetHeader className="border-b px-4 py-3">
          <SheetTitle>Sign in to continue</SheetTitle>
          <SheetDescription>Sign in with the CRM token to change data.</SheetDescription>
        </SheetHeader>
        <div className="p-4">
          <AccessTokenForm compact onSuccess={() => {
            onSuccess()
            onOpenChange(false)
          }} />
        </div>
      </SheetContent>
    </Sheet>
  )
}
