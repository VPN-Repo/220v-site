import { lazy, Suspense } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Index from "./pages/Index";
const Dashboard = lazy(() => import("./pages/Dashboard"));
const PaySuccess = lazy(() => import("./pages/PaySuccess"));
const PayFail = lazy(() => import("./pages/PayFail"));
const Chat = lazy(() => import("./pages/Chat"));
const Policy = lazy(() => import("./pages/Policy"));
const Price = lazy(() => import("./pages/Price"));
const Tariff = lazy(() => import("./pages/Tariff"));
const TariffPay = lazy(() => import("./pages/TariffPay"));
const Traffic = lazy(() => import("./pages/Traffic"));
const TrafficPay = lazy(() => import("./pages/TrafficPay"));
const Instructions = lazy(() => import("./pages/Instructions"));
const Referrals = lazy(() => import("./pages/Referrals"));
const Terms = lazy(() => import("./pages/Terms"));
const UnsubscribeEmail = lazy(() => import("./pages/UnsubscribeEmail"));
const NotFound = lazy(() => import("./pages/NotFound"));
const AdminRedis = lazy(() => import("./pages/AdminRedis"));
const AdminFunnel = lazy(() => import("./pages/AdminFunnel"));
const AdminReferrals = lazy(() => import("./pages/AdminReferrals"));
import RequireVpnAuth from "./components/RequireVpnAuth";
import { SessionProvider } from "./hooks/useSession";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <SessionProvider>
        <Suspense fallback={<div className="min-h-viewport bg-background" />}>
        <Routes>
          <Route path="/" element={<Index />} />
          <Route
            path="/dashboard"
            element={
              <RequireVpnAuth>
                <Dashboard />
              </RequireVpnAuth>
            }
          />
          <Route path="/admin/redis" element={<AdminRedis />} />
          <Route path="/admin/funnel" element={<AdminFunnel />} />
          <Route path="/admin/referrals" element={<AdminReferrals />} />
          <Route path="/policy" element={<Policy />} />
          <Route path="/price" element={<Price />} />
          <Route
            path="/tariff"
            element={
              <RequireVpnAuth>
                <Tariff />
              </RequireVpnAuth>
            }
          />
          <Route
            path="/tariff/pay"
            element={
              <RequireVpnAuth>
                <TariffPay />
              </RequireVpnAuth>
            }
          />
          <Route
            path="/traffic"
            element={
              <RequireVpnAuth>
                <Traffic />
              </RequireVpnAuth>
            }
          />
          <Route
            path="/traffic/pay"
            element={
              <RequireVpnAuth>
                <TrafficPay />
              </RequireVpnAuth>
            }
          />
          <Route
            path="/instructions"
            element={
              <RequireVpnAuth>
                <Instructions />
              </RequireVpnAuth>
            }
          />
          <Route
            path="/referrals"
            element={
              <RequireVpnAuth>
                <Referrals />
              </RequireVpnAuth>
            }
          />
          <Route path="/terms" element={<Terms />} />
          <Route path="/unsubscribe-email" element={<UnsubscribeEmail />} />
          <Route
            path="/support"
            element={
              <RequireVpnAuth>
                <Navigate to="/chat" replace />
              </RequireVpnAuth>
            }
          />
          <Route
            path="/chat"
            element={
              <RequireVpnAuth>
                <Chat />
              </RequireVpnAuth>
            }
          />
          <Route path="/pay/success" element={<PaySuccess />} />
          <Route path="/pay/fail" element={<PayFail />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
</Suspense>
        </SessionProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
