pub mod builtin;
pub mod registry;
pub mod types;

pub use builtin::{
    approval_policy, builtin_tools_plugin, create_builtin_tools, html_to_text,
    ApprovalPolicyOptions, BuiltinToolsOptions, BUILTIN_TOOL_NAMES,
};
pub use registry::{
    to_json_schema, tools_plugin, validate_schema, DefaultToolRegistry, ToolRegistryOptions,
};
pub use types::{
    define_tool, tool_output, ApprovalRequest, ApprovalResponse, ApprovalService,
    ApprovalServiceHandle, BatchContext, ExecuteFn, ExecutionMode, Permission, PreExecutePayload,
    RenderFn, ToolContent, ToolDecision, ToolDefinition, ToolExecContext, ToolFilter, ToolOutput,
    ToolRegistry, ToolRegistryHandle, ToolResult,
};
