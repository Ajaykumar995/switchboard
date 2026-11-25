import { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { useAuth } from './AuthContext';
import { fetchMessages, replyToConversation, closeConversation, reopenConversation, Message } from './api';
import { useWebSocket, WSEvent } from './useWebSocket';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';

export function ConversationDetail() {
  const { session, loading: authLoading } = useAuth();
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [assignee, setAssignee] = useState<string | null>(null);
  const [contact, setContact] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useLayoutEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const [searchParams] = useSearchParams();
  const location = useLocation();

  const handleWSEvent = (event: WSEvent) => {
    if (event.type === 'message.inbound') {
      // Add new inbound message
      setMessages((prev) => {
        // Check if message already exists
        if (prev.some((m) => m.messageId === event.data.message_id)) {
          return prev;
        }
        return [...prev, {
          _id: `ws-${Date.now()}`,
          workspace: event.workspace,
          conversationId: '',
          contact: event.data.from,
          messageId: event.data.message_id,
          text: event.data.text,
          direction: 'inbound',
          occurredAt: event.data.occurred_at,
          createdAt: new Date().toISOString(),
        }];
      });
    } else if (event.type === 'message.status') {
      // Update outbound message status - could update UI here
      console.log('Message status update:', event.data);
    } else if (event.type === 'conversation.claimed' || event.type === 'conversation.closed' || event.type === 'conversation.reopened') {
      // Refresh conversation list or assignee
      console.log('Conversation event:', event.type, event.data);
    }
  };

  useWebSocket(workspace, handleWSEvent);

  useEffect(() => {
    const ws = searchParams.get('workspace');
    const c = searchParams.get('contact');
    if (ws && c) {
      setWorkspace(ws);
      setContact(c);
    }
  }, [searchParams]);

  useEffect(() => {
    if (workspace && contact && session) {
      loadMessages();
    } else {
      setMessages([]);
      setLoading(false);
    }
  }, [workspace, contact, session]);

  const loadMessages = async () => {
    if (!workspace || !contact) return;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchMessages(workspace, contact);
      setMessages(data);
      // Get assignee from first message's conversation (would need separate API call ideally)
    } catch (err) {
      setError('Failed to load messages');
    } finally {
      setLoading(false);
    }
  };

  const handleReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!replyText.trim() || !workspace || !contact || !session) return;
    setSending(true);
    try {
      const clientRef = `client-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const success = await replyToConversation(workspace, contact, replyText, clientRef);
      if (success) {
        setReplyText('');
        // Optimistically add to messages
        setMessages((prev) => [...prev, {
          _id: `optimistic-${Date.now()}`,
          workspace,
          conversationId: '',
          contact,
          messageId: clientRef,
          text: replyText,
          direction: 'outbound',
          occurredAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        }]);
      }
    } catch (err) {
      setError('Failed to send message');
    } finally {
      setSending(false);
    }
  };

  const handleClose = async () => {
    if (!workspace || !contact) return;
    try {
      await closeConversation(workspace, contact);
      setAssignee(null);
    } catch (err) {
      setError('Failed to close conversation');
    }
  };

  const handleReopen = async () => {
    if (!workspace || !contact || !session) return;
    try {
      await reopenConversation(workspace, contact, session.sub);
      setAssignee(session.sub);
    } catch (err) {
      setError('Failed to reopen conversation');
    }
  };

  const handleBack = () => {
    navigate('/');
  };

  if (authLoading) {
    return <div style={styles.loading}>Loading…</div>;
  }

  if (!workspace || !contact) {
    return <div style={styles.empty}>Select a conversation</div>;
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <button style={styles.backButton} onClick={handleBack}>
          ← Back
        </button>
        <div style={styles.headerInfo}>
          <h2 style={styles.title}>{contact}</h2>
          <span style={styles.workspace}>{workspace}</span>
        </div>
        <div style={styles.headerActions}>
          {assignee === session?.sub ? (
            <button style={styles.buttonSecondary} onClick={handleClose}>
              Close
            </button>
          ) : assignee ? (
            <span style={styles.assignedTo}>Assigned to {assignee}</span>
          ) : (
            <button style={styles.buttonSecondary} onClick={handleReopen}>
              Reopen
            </button>
          )}
        </div>
      </div>
      {error && <div style={styles.error}>{error}</div>}
      <div style={styles.messagesContainer} ref={messagesEndRef}>
        {loading ? (
          <div style={styles.loading}>Loading messages…</div>
        ) : messages.length === 0 ? (
          <div style={styles.emptyMessages}>No messages yet</div>
        ) : (
          messages.map((msg) => (
            <div key={msg._id} style={{
              ...styles.message,
              ...(msg.direction === 'outbound' ? styles.messageOutbound : styles.messageInbound)
            }}>
              <div style={styles.messageBubble}>{msg.text}</div>
              <div style={styles.messageMeta}>
                {new Date(msg.occurredAt).toLocaleTimeString()}
                {msg.direction === 'outbound' && <span style={styles.outboundBadge}>sent</span>}
              </div>
            </div>
          ))
        )}
      </div>
      <form style={styles.replyForm} onSubmit={handleReply}>
        <input
          style={styles.replyInput}
          type="text"
          value={replyText}
          onChange={(e) => setReplyText(e.target.value)}
          placeholder="Type a reply…"
          disabled={sending}
        />
        <button style={styles.replyButton} type="submit" disabled={sending || !replyText.trim()}>
          {sending ? 'Sending…' : 'Send'}
        </button>
      </form>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    background: '#fafafa',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
    padding: '12px 16px',
    background: 'white',
    borderBottom: '1px solid #e0e0e0',
  },
  backButton: {
    padding: '8px 12px',
    background: 'none',
    border: '1px solid #ccc',
    borderRadius: '4px',
    cursor: 'pointer',
  },
  headerInfo: {
    flex: 1,
  },
  title: {
    margin: 0,
    fontSize: '18px',
  },
  workspace: {
    fontSize: '12px',
    color: '#666',
  },
  headerActions: {},
  buttonSecondary: {
    padding: '8px 12px',
    background: '#fff',
    border: '1px solid #ccc',
    borderRadius: '4px',
    cursor: 'pointer',
  },
  assignedTo: {
    fontSize: '12px',
    color: '#666',
  },
  error: {
    padding: '12px 16px',
    color: '#d32f2f',
    background: '#ffebee',
  },
  messagesContainer: {
    flex: 1,
    overflow: 'auto',
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  loading: {
    textAlign: 'center',
    padding: '20px',
    color: '#666',
  },
  emptyMessages: {
    textAlign: 'center',
    padding: '20px',
    color: '#999',
  },
  message: {
    maxWidth: '70%',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  messageInbound: {
    alignSelf: 'flex-start',
  },
  messageOutbound: {
    alignSelf: 'flex-end',
  },
  messageBubble: {
    padding: '10px 14px',
    borderRadius: '16px',
    fontSize: '14px',
    lineHeight: 1.4,
  },
  messageMeta: {
    fontSize: '11px',
    color: '#999',
    display: 'flex',
    gap: '8px',
    alignItems: 'center',
  },
  outboundBadge: {
    background: '#e3f2fd',
    color: '#1976d2',
    padding: '2px 6px',
    borderRadius: '8px',
    fontSize: '10px',
  },
  replyForm: {
    display: 'flex',
    gap: '8px',
    padding: '12px 16px',
    background: 'white',
    borderTop: '1px solid #e0e0e0',
  },
  replyInput: {
    flex: 1,
    padding: '10px 14px',
    border: '1px solid #ccc',
    borderRadius: '20px',
    fontSize: '14px',
    outline: 'none',
  },
  replyButton: {
    padding: '10px 20px',
    background: '#0066cc',
    color: 'white',
    border: 'none',
    borderRadius: '20px',
    cursor: 'pointer',
    fontSize: '14px',
  },
};