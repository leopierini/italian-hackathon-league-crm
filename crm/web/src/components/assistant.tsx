import { useEffect, useRef, useState } from "react"
import { Link } from "react-router"
import { ArrowUp, Loader2, PencilLine } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { SignInDialog } from "@/components/sign-in-dialog"
import { Textarea } from "@/components/ui/textarea"
import { ApiFailure, api, useApi } from "@/lib/api"

type Turn = { role: "user" | "assistant"; content: string; actions?: string[]; failed?: boolean }
type User = { id: string; first_name: string; last_name: string; email: string; active: boolean }

const examples = [
  "What is the 2025 revenue and class of Officine Rossi?",
  "Which urgent tickets are still open?",
  "How many dormant customers do we have?",
]

// "updated deals "Fornitura X" (id 123): dealstage ..." -> a link when the record has a page.
function ActionLine({ text }: { text: string }) {
  const m = /^(created|updated|archived|associated|removed association)\s+(\w+)\s+"([^"]*)"(?:.*?\(id (\d+)\))?/.exec(text)
  const verb = m?.[1] ?? ""
  const type = m?.[2] ?? ""
  const id = m?.[4]
  const href = type === "companies" && id ? `/companies/${id}` : null
  return (
    <li className="flex gap-2 text-xs">
      <PencilLine className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 break-words">
        {href ? (
          <>
            {verb} {type.replace(/s$/, "")}{" "}
            <Link to={href} className="font-medium underline underline-offset-2">
              {m?.[3]}
            </Link>
            {text.slice(m![0].length)}
          </>
        ) : (
          text
        )}
      </span>
    </li>
  )
}

export function AssistantPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState("")
  const [busy, setBusy] = useState(false)
  const [user, setUser] = useState("")
  const [signInOpen, setSignInOpen] = useState(false)
  const [pendingMessage, setPendingMessage] = useState<string | null>(null)
  const users = useApi<{ results: User[] }>(open ? "/ui-api/users" : null)
  const end = useRef<HTMLDivElement>(null)
  const active = (users.data?.results ?? []).filter((u) => u.active)

  useEffect(() => {
    if (!user && active.length) setUser(active[0]!.email)
  }, [active, user])
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" })
  }, [turns, busy])

  async function send(text: string) {
    const content = text.trim()
    if (!content || busy) return
    const next: Turn[] = [...turns, { role: "user", content }]
    setTurns(next)
    setDraft("")
    setBusy(true)
    try {
      const result = await api<{ reply: string; actions: string[] }>("/ui-api/assistant", {
        method: "POST",
        body: JSON.stringify({ user, messages: next.filter((t) => !t.failed).map((t) => ({ role: t.role, content: t.content })) }),
      })
      setTurns([...next, { role: "assistant", content: result.reply, actions: result.actions }])
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 401) {
        setTurns(turns)
        setDraft(content)
        setPendingMessage(content)
        setSignInOpen(true)
        return
      }
      setTurns([...next, { role: "assistant", content: `${(e as Error).message} Nothing was changed. Send the message again to retry.`, failed: true }])
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b px-4 py-3">
          <SheetTitle>Assistant</SheetTitle>
          <SheetDescription>Ask about customers, deals and tickets, or ask for a change. It answers in your language.</SheetDescription>
          <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            Writing as
            <select
              value={user}
              onChange={(e) => setUser(e.target.value)}
              className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              {active.map((u) => (
                <option key={u.id} value={u.email}>
                  {u.first_name} {u.last_name} · {u.email}
                </option>
              ))}
            </select>
          </label>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {turns.length === 0 ? (
            <div className="flex flex-col gap-2 text-sm">
              <p className="text-muted-foreground">Try one of these, or write your own request:</p>
              {examples.map((e) => (
                <button
                  key={e}
                  onClick={() => send(e)}
                  className="rounded-md border px-3 py-2 text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  {e}
                </button>
              ))}
            </div>
          ) : (
            <ol className="flex flex-col gap-4">
              {turns.map((t, i) => (
                <li key={i} className={t.role === "user" ? "self-end" : ""}>
                  {t.role === "user" ? (
                    <div className="max-w-[85vw] rounded-lg bg-muted px-3 py-2 text-sm whitespace-pre-wrap sm:max-w-sm">{t.content}</div>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {t.actions?.length ? (
                        <div className="rounded-md border px-3 py-2">
                          <p className="mb-1 text-xs font-medium">Changes in the CRM</p>
                          <ul className="flex flex-col gap-1">
                            {t.actions.map((a, j) => (
                              <ActionLine key={j} text={a} />
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      <div className={t.failed ? "text-sm text-destructive" : "text-sm whitespace-pre-wrap"}>{t.content}</div>
                    </div>
                  )}
                </li>
              ))}
              {busy ? (
                <li role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  Reading the CRM and preparing an answer
                </li>
              ) : null}
            </ol>
          )}
          <div ref={end} />
        </div>
        <form
          className="flex items-end gap-2 border-t p-3"
          onSubmit={(e) => {
            e.preventDefault()
            send(draft)
          }}
        >
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                send(draft)
              }
            }}
            rows={2}
            placeholder="Ask a question or request a change"
            aria-label="Message to the assistant"
            className="min-h-0 resize-none"
          />
          <Button type="submit" size="icon" disabled={busy || !draft.trim()} aria-label="Send message">
            <ArrowUp className="size-4" aria-hidden />
          </Button>
        </form>
      </SheetContent>
      </Sheet>
      <SignInDialog
        open={signInOpen}
        onOpenChange={(nextOpen) => {
          setSignInOpen(nextOpen)
          if (!nextOpen) setPendingMessage(null)
        }}
        onSuccess={() => {
          const message = pendingMessage
          setPendingMessage(null)
          if (message) void send(message)
        }}
      />
    </>
  )
}
