import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './AuthContext';
import { Login } from './Login';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { ConversationList } from './ConversationList';
import { ConversationDetail } from './ConversationDetail';

function PrivateRoutes() {
  const { session, loading } = useAuth();

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
        Loading…
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div style={styles.layout}>
      <WorkspaceSwitcher />
      <div style={styles.main}>
        <Routes>
          <Route path="/conversation" element={<ConversationDetail />} />
          <Route path="/" element={<ConversationList />} />
        </Routes>
      </div>
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/*" element={<PrivateRoutes />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

const styles: Record<string, React.CSSProperties> = {
  layout: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
  },
  main: {
    flex: 1,
    display: 'flex',
    overflow: 'hidden',
  },
};