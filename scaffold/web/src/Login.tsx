import { useAuth } from './AuthContext';
import { useNavigate } from 'react-router-dom';

export function Login() {
  const { login, loading } = useAuth();
  const navigate = useNavigate();

  const handleLogin = () => {
    login();
  };

  if (loading) {
    return (
      <div style={styles.container}>
        <div style={styles.card}>
          <h1>Switchboard</h1>
          <p>Loading…</p>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1>Switchboard</h1>
        <p>Sign in to continue</p>
        <button style={styles.button} onClick={handleLogin} disabled={loading}>
          Sign in with OIDC
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: '100vh',
    background: '#f5f5f5',
  },
  card: {
    background: 'white',
    padding: '40px',
    borderRadius: '8px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
    textAlign: 'center',
    minWidth: 320,
  },
  button: {
    marginTop: '20px',
    padding: '12px 24px',
    fontSize: '16px',
    background: '#0066cc',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
  },
};