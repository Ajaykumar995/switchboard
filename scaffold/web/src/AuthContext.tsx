import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { fetchMe, logout as apiLogout, login as apiLogin, SessionData } from './api';

interface AuthContextType {
  session: SessionData | null;
  loading: boolean;
  login: () => void;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    const data = await fetchMe();
    setSession(data);
    setLoading(false);
  };

  useEffect(() => {
    refresh();
  }, []);

  const login = () => {
    apiLogin();
  };

  const logout = async () => {
    await apiLogout();
    setSession(null);
  };

  return (
    <AuthContext.Provider value={{ session, loading, login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}