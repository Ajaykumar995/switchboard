import { useAuth } from './AuthContext';
import { useNavigate, useLocation } from 'react-router-dom';

export function WorkspaceSwitcher() {
  const { session, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  if (loading || !session) {
    return null;
  }

  const currentWorkspace = new URLSearchParams(location.search).get('workspace');
  const workspaces = session.workspaces;

  if (workspaces.length === 0) {
    return (
      <div style={styles.container}>
        <p style={styles.empty}>No workspaces available</p>
      </div>
    );
  }

  const handleChange = (workspaceId: string) => {
    const params = new URLSearchParams(location.search);
    params.set('workspace', workspaceId);
    navigate(`${location.pathname}?${params.toString()}`);
  };

  return (
    <div style={styles.container}>
      <select
        style={styles.select}
        value={currentWorkspace || workspaces[0].id}
        onChange={(e) => handleChange(e.target.value)}
      >
        {workspaces.map((ws) => (
          <option key={ws.id} value={ws.id}>
            {ws.id} ({ws.role})
          </option>
        ))}
      </select>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '12px 16px',
    borderBottom: '1px solid #e0e0e0',
  },
  select: {
    padding: '8px 12px',
    fontSize: '14px',
    border: '1px solid #ccc',
    borderRadius: '4px',
    background: 'white',
    minWidth: 200,
  },
  empty: {
    color: '#666',
    fontSize: '14px',
  },
};