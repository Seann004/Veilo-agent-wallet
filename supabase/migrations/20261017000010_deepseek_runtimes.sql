-- v2 managed runtimes run on DeepSeek V4 Flash. v1 rows stay unchanged so earlier listings keep
-- naming the model their buyers were quoted for.
insert into public.runtime_versions (id, kind, template, model_id, max_output_tokens, max_seconds, description) values
  ('managed:research-summary:v2', 'managed_template', 'research-summary', 'deepseek/deepseek-v4-flash', 2000, 600, 'Cited research summary from the brief'),
  ('managed:structured-analysis:v2', 'managed_template', 'structured-analysis', 'deepseek/deepseek-v4-flash', 2000, 600, 'Structured analysis with findings and risks'),
  ('managed:content-package:v2', 'managed_template', 'content-package', 'deepseek/deepseek-v4-flash', 3000, 600, 'Three channel drafts and a seven-day plan')
on conflict (id) do nothing;
