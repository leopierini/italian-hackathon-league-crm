import { useState } from "react"
import { KeyRound, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { setToken } from "@/lib/api"

export function AccessTokenForm({ onSuccess, compact = false }: { onSuccess?: () => void; compact?: boolean }) {
  const [value, setValue] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const token = value.trim()
    setBusy(true)
    setError("")
    try {
      const response = await fetch("/crm/objects/2026-09/contacts?limit=1", {
        headers: { authorization: `Bearer ${token}` },
      })
      if (response.ok) {
        setToken(token)
        onSuccess?.()
      } else if (response.status === 401) {
        setError("This token was not accepted. Copy it again from the platform's Deploy page.")
      } else {
        setError(`The CRM answered ${response.status}. Try again.`)
      }
    } catch {
      setError("The CRM did not answer. Check your connection and try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex w-full flex-col gap-4">
      {!compact ? (
        <div className="flex items-center gap-2">
          <span aria-hidden className="grid size-8 place-items-center rounded-md bg-foreground font-mono text-xs font-semibold text-background">BF</span>
          <div className="leading-tight">
            <h1 className="text-base font-semibold">Brambilla CRM</h1>
            <p className="text-xs text-muted-foreground">Industrial supplies</p>
          </div>
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="token" className="text-sm font-medium">Access token</label>
        <Input id="token" type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Paste the CRM access token" />
        <p className="text-xs text-muted-foreground">
          {compact ? "The token is kept only in this browser tab." : "The same token the API uses. It is kept only in this browser tab."}
        </p>
      </div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <Button type="submit" disabled={busy || !value.trim()}>
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <KeyRound className="size-4" aria-hidden />}
        {compact ? "Sign in and continue" : "Open the CRM"}
      </Button>
    </form>
  )
}

export function LoginPage() {
  return (
    <main className="grid min-h-svh place-items-center bg-background px-4">
      <div className="w-full max-w-sm">
        <AccessTokenForm />
      </div>
    </main>
  )
}
