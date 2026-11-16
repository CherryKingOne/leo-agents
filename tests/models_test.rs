use leo_agents::cli::models::{
    describe_model, describe_reasoning, parse_effort, parse_switch, with_effort, with_thinking,
};
use leo_agents::create_Leo;
use leo_agents::errors::LeoResult;
use leo_agents::kernel::LogLevel;
use leo_agents::llm::{
    LlmProvider, LlmRequest, LlmStream, LlmStreamEvent, ModelInfo, ModelPricing,
    ModelReasoningInfo, ReasoningEffort, ReasoningOptions, StreamOptions,
};
use leo_agents::CreateLeoOptions;
use std::sync::Arc;

struct TestProvider {
    id: &'static str,
    models: Vec<ModelInfo>,
    refresh: Result<Vec<ModelInfo>, String>,
}

#[async_trait::async_trait]
impl LlmProvider for TestProvider {
    fn id(&self) -> &str {
        self.id
    }
    fn get_model_info(&self, model: &str) -> Option<ModelInfo> {
        self.models.iter().find(|m| m.id == model).cloned()
    }
    fn list_models(&self) -> Vec<ModelInfo> {
        self.models.clone()
    }
    async fn refresh_models(&self) -> LeoResult<Vec<ModelInfo>> {
        match &self.refresh {
            Ok(m) => Ok(m.clone()),
            Err(e) => Err(leo_agents::LeoError::new(
                leo_agents::LeoErrorCode::Network,
                e.clone(),
            )),
        }
    }
    fn stream(&self, _request: LlmRequest, _opts: StreamOptions) -> LlmStream {
        Box::pin(futures::stream::empty())
    }
}

fn flash() -> ModelInfo {
    ModelInfo {
        id: "deepseek-flash".into(),
        name: Some("DeepSeek-V4.1-Flash".into()),
        context_window: 1_048_576,
        max_output_tokens: Some(393_216),
        input_modalities: Some(vec!["text".into(), "image".into()]),
        reasoning: Some(ModelReasoningInfo {
            supported: true,
            can_disable: Some(true),
            default_enabled: Some(true),
            efforts: Some(vec![
                ReasoningEffort::Low,
                ReasoningEffort::High,
                ReasoningEffort::Max,
            ]),
            default_effort: Some(ReasoningEffort::High),
        }),
        ..Default::default()
    }
}

#[tokio::test]
async fn models_refresh_hides_aliases_and_falls_back() {
    let remote = Arc::new(TestProvider {
        id: "r",
        models: vec![ModelInfo {
            id: "old".into(),
            context_window: 1,
            ..Default::default()
        }],
        refresh: Ok(vec![
            flash(),
            ModelInfo {
                id: "deepseek-chat".into(),
                alias: Some(true),
                ..flash()
            },
        ]),
    });
    let broken = Arc::new(TestProvider {
        id: "b",
        models: vec![ModelInfo {
            id: "builtin".into(),
            context_window: 2,
            ..Default::default()
        }],
        refresh: Err("401 unauthorized".into()),
    });
    let leo = create_Leo(CreateLeoOptions {
        providers: vec![remote, broken],
        log_level: Some(LogLevel::Silent),
        ..Default::default()
    })
    .await
    .unwrap();
    let llm = leo.ctx.get::<leo_agents::llm::LlmService>("llm").unwrap();
    let groups = llm.models(true, None, None).await.unwrap();
    let summary: Vec<(String, Vec<String>, Option<String>)> = groups
        .into_iter()
        .map(|g| {
            (
                g.provider.id().to_string(),
                g.models.iter().map(|m| m.id.clone()).collect(),
                g.error,
            )
        })
        .collect();
    assert_eq!(
        summary,
        vec![
            ("r".into(), vec!["deepseek-flash".into()], None),
            (
                "b".into(),
                vec!["builtin".into()],
                Some("401 unauthorized".into())
            ),
        ]
    );
    let groups = llm.models(false, Some("r"), None).await.unwrap();
    assert_eq!(groups[0].models[0].id, "old");
    assert!(llm.models(false, Some("nope"), None).await.is_err());
}

#[test]
fn cli_reasoning_helpers() {
    assert_eq!(parse_switch(Some("on")), Some(true));
    assert_eq!(parse_switch(Some("关")), Some(false));
    assert_eq!(parse_switch(Some("maybe")), None);
    assert_eq!(parse_effort(Some("MAX")), Some(ReasoningEffort::Max));
    assert_eq!(parse_effort(Some("ultra")), None);
    assert_eq!(
        with_effort(ReasoningEffort::None),
        ReasoningOptions {
            enabled: Some(false),
            effort: None
        }
    );
    assert_eq!(
        with_effort(ReasoningEffort::Low),
        ReasoningOptions {
            enabled: Some(true),
            effort: Some(ReasoningEffort::Low)
        }
    );
    assert_eq!(
        with_thinking(
            &ReasoningOptions {
                enabled: None,
                effort: Some(ReasoningEffort::Max)
            },
            false
        ),
        ReasoningOptions {
            enabled: Some(false),
            effort: None
        }
    );
    assert_eq!(
        with_thinking(
            &ReasoningOptions {
                enabled: None,
                effort: Some(ReasoningEffort::None)
            },
            true
        ),
        ReasoningOptions {
            enabled: Some(true),
            effort: None
        }
    );
    assert_eq!(
        describe_model(&flash()),
        "DeepSeek-V4.1-Flash · 上下文 1M · 最大输出 384K · 输入 text+image · 思考（默认开），强度 low/high*/max"
    );
    assert_eq!(
        describe_reasoning(None, Some(&flash())),
        "思考开（默认） · 强度 high（默认）"
    );
    assert_eq!(
        describe_reasoning(
            Some(&ReasoningOptions {
                enabled: Some(false),
                effort: None
            }),
            Some(&flash())
        ),
        "思考关"
    );
    assert_eq!(
        describe_reasoning(
            Some(&ReasoningOptions {
                enabled: Some(true),
                effort: Some(ReasoningEffort::Max)
            }),
            Some(&flash())
        ),
        "思考开 · 强度 max"
    );
    let no_reasoning = ModelInfo {
        id: "x".into(),
        context_window: 1,
        reasoning: Some(ModelReasoningInfo {
            supported: false,
            ..Default::default()
        }),
        ..Default::default()
    };
    assert_eq!(describe_reasoning(None, Some(&no_reasoning)), "不支持思考");
    let _ = ModelPricing::default();
    let _ = LlmStreamEvent::Done {
        finish_reason: leo_agents::llm::FinishReason::Stop,
    };
}
