use futures::future::join_all;
use leo_agents::context::sanitize_messages;
use leo_agents::protocol::messages::{new_id, AgentMessage, ContentBlock};
use leo_agents::session::{derive_messages, FileSessionStore, SessionStore};
use serde_json::json;
use std::sync::Arc;

fn msg(role: &str, text: &str) -> AgentMessage {
    AgentMessage::new(role, vec![ContentBlock::text(text)])
}

#[tokio::test]
async fn file_store_appends_jsonl_with_monotonic_seq_under_concurrency() {
    let dir = std::env::temp_dir().join(format!("leo-test-{}", new_id("d")));
    let _ = std::fs::remove_dir_all(&dir);
    let store = Arc::new(FileSessionStore::new(dir.clone(), None));
    let mut tasks = Vec::new();
    for i in 0..20 {
        let store = store.clone();
        tasks.push(tokio::spawn(async move {
            store
                .append(
                    "s1",
                    "message",
                    json!({ "message": msg("user", &format!("m{}", i)) }),
                )
                .await
                .unwrap();
        }));
    }
    for t in tasks {
        t.await.unwrap();
    }
    let events = store.events("s1").await.unwrap();
    let seqs: Vec<u64> = events.iter().map(|e| e.seq).collect();
    assert_eq!(seqs, (1..=20).collect::<Vec<_>>());
    assert_eq!(store.messages("s1").await.unwrap().len(), 20);

    let fresh = FileSessionStore::new(dir.clone(), None);
    let e = fresh
        .append("s1", "custom", json!({ "kind": "x" }))
        .await
        .unwrap();
    assert_eq!(e.seq, 21);
    assert!(store.append("../evil", "custom", json!({})).await.is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn derive_messages_applies_compaction() {
    let a = msg("user", "a");
    let b = msg("assistant", "b");
    let c = msg("user", "c");
    let mut summary = msg("user", "summary");
    summary.meta = Some(json!({ "compaction": true }));
    let events = vec![
        event("message", json!({ "message": a })),
        event("message", json!({ "message": b })),
        event(
            "compaction",
            json!({ "summary": summary, "replacesUpTo": b.id, "strategy": "t" }),
        ),
        event("message", json!({ "message": c })),
    ];
    let out = derive_messages(&events);
    let ids: Vec<&str> = out.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids.len(), 2);
    assert_eq!(out[1].content, vec![ContentBlock::text("c")]);
}

fn event(kind: &str, data: serde_json::Value) -> leo_agents::session::SessionEvent {
    leo_agents::session::SessionEvent {
        id: new_id("evt"),
        session_id: "s".into(),
        seq: 1,
        event_type: kind.into(),
        at: 0,
        data,
    }
}

#[test]
fn sanitize_messages_repairs_missing_and_orphan_tool_results() {
    let asst = AgentMessage {
        id: "a".into(),
        role: "assistant".into(),
        content: vec![
            ContentBlock::ToolCall {
                id: "t1".into(),
                name: "x".into(),
                arguments: json!({}),
                raw_arguments: "{}".into(),
            },
            ContentBlock::ToolCall {
                id: "t2".into(),
                name: "y".into(),
                arguments: json!({}),
                raw_arguments: "{}".into(),
            },
        ],
        tool_call_id: None,
        tool_name: None,
        is_error: None,
        created_at: 0,
        meta: None,
    };
    let out = sanitize_messages(vec![
        msg("tool", "orphan"),
        msg("user", "u"),
        asst,
        msg("tool", "r2"),
    ]);
    let roles: Vec<(&str, Option<&str>)> = out
        .iter()
        .map(|m| (m.role.as_str(), m.tool_call_id.as_deref()))
        .collect();
    assert_eq!(
        roles,
        vec![
            ("user", None),
            ("assistant", None),
            ("tool", Some("t1")),
            ("tool", Some("t2")),
        ]
    );
    assert_eq!(out[2].is_error, Some(true));
}
