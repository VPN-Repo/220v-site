import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Index from "./pages/Index";
import Dashboard from "./pages/Dashboard";
import PaySuccess from "./pages/PaySuccess";
import PayFail from "./pages/PayFail";
import Chat from "./pages/Chat";
import Policy from "./pages/Policy";
import Price from "./pages/Price";
import Tariff from "./pages/Tariff";
import TariffPay from "./pages/TariffPay";
import Traffic from "./pages/Traffic";
import TrafficPay from "./pages/TrafficPay";
import Instructions from "./pages/Instructions";
import Referrals from "./pages/Referrals";
import Terms from "./pages/Terms";
import UnsubscribeEmail from "./pages/UnsubscribeEmail";
import NotFound from "./pages/NotFound";
import AdminRedis from "./pages/AdminRedis";
import AdminReferrals from "./pages/AdminReferrals";
import RequireVpnAuth from "./components/RequireVpnAuth";
import { PromoProvider } from "./components/PromoProvider";
import { SessionProvider } from "./hooks/useSession";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <SessionProvider>
        <PromoProvider>
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
        </PromoProvider>
        </SessionProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
