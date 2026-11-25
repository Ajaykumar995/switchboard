import { useState, useEffect } from 'react';
import { useAuth } from './AuthContext';
import { fetchConversations, claimConversation, Conversation } from './api';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';

export function ConversationList() {
  const { session, loading: authLoading } = useAuth();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const workspace = searchParams.get('workspace');
  const location = useLocation();

  useEffect(() => {
    if (workspace && session) {
      loadConversations();
    } else {
      setConversations([]);
      setLoading(false);
    }
  }, [workspace, session]);

  const loadConversations = async () => {
    if (!workspace) return;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchConversations(workspace);
      setConversations(data);
    } catch (err) {
      setError('Failed to load conversations');
    } finally {
      setLoading(false);
    }
  };

  const handleClaim = async (contact: string) => {
    if (!workspace || !session) return;
    const agent = session.sub;
    const success = await claimConversation(workspace, contact, agent);
    if (success) {
      await loadConversations();
    }
  };

  const handleOpen = (contact: string) => {
    const params = new URLSearchParams(location.search);
    params.set('contact', contact);
    navigate(`/conversation?${params.toString()}`);
  };

  if (authLoading) {
    return <div style={styles.loading}>Loading…</div>;
  }

  if (!workspace) {
    return <div style={styles.empty}>Select a workspace</div>;
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h2 style={styles.title}>Conversations</h2>
        <span style={styles.count}>{conversations.length}</span>
      </div>
      {error && <div style={styles.error}>{error}</div>}
      {loading ? (
        <div style={styles.loading}>Loading conversations…</div>
      ) : conversations.length === 0 ? (
        <div style={styles.empty}>No conversations yet</div>
      ) : (
        <ul style={styles.list}>
          {conversations.map((conv) => (
            <li key={conv._id} style={styles.item}>
              <div style={styles.itemMain}>
                <div style={styles.contact}>{conv.contact}</div>
                <div style={styles.meta}>
                  <span style={styles.assignee}>
                    {conv.assignee ? `Assigned: ${conv.assignee}` : 'Unassigned'}
                  </span>
                  <span style={styles.updated}>
                    {new Date(conv.updatedAt).toLocaleString()}
                  </span>
                </div>
              </div>
              <div style={styles.actions}>
                {conv.assignee === session?.sub ? (
                  <button
                    style={styles.buttonPrimary}
                    onClick={() => handleOpen(conv.contact)}
                  >
                    Open
                  </button>
                ) : conv.assignee ? (
                  <span style={styles.assignedToOther}>Assigned to {conv.assignee}</span>
                ) : (
                  <button
                    style={styles.buttonPrimary}
                    onClick={() => handleClaim(conv.contact)}
                  >
                    Claim
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    overflow: 'auto',
    padding: '16px',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '16px',
  },
  title: {
    margin: 0,
    fontSize: '18px',
  },
  count: {
    background: '#e0e0e0',
    padding: '4px 8px',
    borderRadius: '12px',
    fontSize: '12px',
  },
  error: {
    color: '#d32f2f',
    marginBottom: '16px',
    padding: '8px',
    background: '#ffebee',
    borderRadius: '4px',
  },
  loading: {
    padding: '20px',
    textAlign: 'center',
    color: '#666',
  },
  empty: {
    padding: '20px',
    textAlign: 'center',
    color: '#999',
  },
  list: {
    listStyle: 'none',
    padding: 0,
    margin: 0,
  },
  item: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px',
    border: '1px solid #e0e0e0',
    borderRadius: '8px',
    marginBottom: '8px',
    background: 'white',
  },
  itemMain: {
    flex: 1,
  },
  contact: {
    fontWeight: 500,
    fontSize: '16px',
  },
  meta: {
    display: 'flex',
    gap: '16px',
    marginTop: '4px',
    fontSize: '12px',
    color: '#666',
  },
  assignee: {},
  updated: {},
  actions: {
    marginLeft: '16px',
  },
  buttonPrimary: {
    padding: '8px 16px',
    background: '#0066cc',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '14px',
  },
  assignedToOther: {
    fontSize: '12px',
    color: '#999',
  },
};