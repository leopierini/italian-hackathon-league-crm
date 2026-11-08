import { BrowserRouter, Navigate, Route, Routes } from "react-router"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Layout } from "@/components/layout"
import { CompaniesPage } from "@/pages/companies"
import { CompanyPage } from "@/pages/company"
import { ContactsPage } from "@/pages/contacts"
import { DealsPage } from "@/pages/deals"
import { DormantPage } from "@/pages/dormant"
import { TicketsPage } from "@/pages/tickets"

export function App() {
  return (
    <TooltipProvider>
      <BrowserRouter>
        <Layout>
          <Routes>
            <Route path="/" element={<Navigate to="/companies" replace />} />
            <Route path="/login" element={<Navigate to="/companies" replace />} />
            <Route path="/companies" element={<CompaniesPage />} />
            <Route path="/companies/:id" element={<CompanyPage />} />
            <Route path="/contacts" element={<ContactsPage />} />
            <Route path="/deals" element={<DealsPage />} />
            <Route path="/tickets" element={<TicketsPage />} />
            <Route path="/dormant-customers" element={<DormantPage />} />
            <Route path="*" element={<Navigate to="/companies" replace />} />
          </Routes>
        </Layout>
      </BrowserRouter>
      <Toaster position="bottom-right" theme="light" />
    </TooltipProvider>
  )
}

export default App
