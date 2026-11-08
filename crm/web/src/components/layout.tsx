import { useEffect, useState, type ReactNode } from "react"
import { NavLink } from "react-router"
import { Building2, KanbanSquare, LifeBuoy, LogOut, Menu, MoonStar, Sparkles, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { AssistantPanel } from "@/components/assistant"
import { getToken, setToken } from "@/lib/api"
import { cn } from "@/lib/utils"

const nav = [
  { to: "/companies", label: "Companies", icon: Building2 },
  { to: "/contacts", label: "Contacts", icon: Users },
  { to: "/deals", label: "Deals", icon: KanbanSquare },
  { to: "/tickets", label: "Tickets", icon: LifeBuoy },
  { to: "/dormant-customers", label: "Dormant customers", icon: MoonStar },
]

function Brand() {
  return (
    <div className="flex items-center gap-2 px-2">
      <span aria-hidden className="grid size-7 place-items-center rounded-md bg-foreground font-mono text-xs font-semibold text-background">BF</span>
      <div className="leading-tight">
        <div className="text-sm font-semibold">Brambilla CRM</div>
        <div className="text-[11px] text-muted-foreground">Industrial supplies</div>
      </div>
    </div>
  )
}

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {nav.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              isActive && "bg-muted font-medium text-foreground",
            )
          }
        >
          <item.icon className="size-4" aria-hidden />
          {item.label}
        </NavLink>
      ))}
    </nav>
  )
}

export function Layout({ children }: { children: ReactNode }) {
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [hasToken, setHasToken] = useState(() => Boolean(getToken()))
  useEffect(() => {
    const sync = () => setHasToken(Boolean(getToken()))
    window.addEventListener("crm-auth", sync)
    return () => window.removeEventListener("crm-auth", sync)
  }, [])
  return (
    <div className="flex min-h-svh bg-background text-foreground">
      <aside className="sticky top-0 hidden h-svh w-56 shrink-0 flex-col gap-6 border-r px-3 py-4 md:flex">
        <Brand />
        <NavItems />
        <div className="mt-auto flex flex-col gap-1">
          <Button
            className="h-9 w-full justify-start gap-2.5 bg-assistant-action text-assistant-action-foreground shadow-sm hover:bg-assistant-action-hover focus-visible:ring-assistant-action"
            onClick={() => setAssistantOpen(true)}
          >
            <Sparkles className="size-4" aria-hidden />
            Ask AI assistant
          </Button>
          {hasToken ? (
            <Button variant="ghost" className="justify-start text-muted-foreground" onClick={() => setToken("")}>
              <LogOut className="size-4" aria-hidden />
              Sign out
            </Button>
          ) : <p className="px-2 py-1 text-xs text-muted-foreground">Read-only access</p>}
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex items-center justify-between border-b bg-background/95 px-4 py-2 md:hidden">
          <Button variant="ghost" size="icon" aria-label="Open menu" onClick={() => setMenuOpen(true)}>
            <Menu className="size-5" aria-hidden />
          </Button>
          <Brand />
          <Button
            size="icon"
            aria-label="Ask AI assistant"
            onClick={() => setAssistantOpen(true)}
            className="bg-assistant-action text-assistant-action-foreground shadow-sm hover:bg-assistant-action-hover focus-visible:ring-assistant-action"
          >
            <Sparkles className="size-5" aria-hidden />
          </Button>
        </header>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent side="left" className="w-64 gap-6 p-4">
          <SheetTitle className="sr-only">Menu</SheetTitle>
          <Brand />
          <NavItems onNavigate={() => setMenuOpen(false)} />
          {hasToken ? (
            <Button variant="ghost" className="mt-auto justify-start text-muted-foreground" onClick={() => setToken("")}>
              <LogOut className="size-4" aria-hidden />
              Sign out
            </Button>
          ) : <p className="mt-auto px-2 py-1 text-xs text-muted-foreground">Read-only access</p>}
        </SheetContent>
      </Sheet>
      <AssistantPanel open={assistantOpen} onOpenChange={setAssistantOpen} />
    </div>
  )
}
