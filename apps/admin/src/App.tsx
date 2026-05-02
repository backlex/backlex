import { Route, Routes } from "react-router-dom";
import { Sidebar } from "@/components/sidebar";
import { Dashboard } from "@/pages/dashboard";
import { Collections } from "@/pages/collections";
import { Storage } from "@/pages/storage";
import { Vector } from "@/pages/vector";
import { Realtime } from "@/pages/realtime";
import { SignIn } from "@/pages/sign-in";

export const App = () => (
  <div className="flex h-full">
    <Sidebar />
    <main className="flex-1 overflow-auto">
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/collections" element={<Collections />} />
        <Route path="/storage" element={<Storage />} />
        <Route path="/vector" element={<Vector />} />
        <Route path="/realtime" element={<Realtime />} />
        <Route path="/sign-in" element={<SignIn />} />
      </Routes>
    </main>
  </div>
);
