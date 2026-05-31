# 100x Knowledge Base Alignment Update

This update aligns the AI twin's knowledge base with the 100x Stage 1 assessment and the Generative AI Developer / AI Agent Team role.

## Source requirements reflected

From the JD, the important non-synthetic alignment points are:

- 100x wants builders of AI agents, not feature-only engineers.
- The role emphasizes production-ready agents, executable human playbooks, autonomous conversation handling, memory, logging/transcripts, customer-facing demos, fast iteration, and ownership.
- The role values fast learning, fast decisions, shipping, accountability, and customer-facing conversational improvements.

From the Stage 1 assessment, the important product requirements are:

- Build a voice bot that answers as the candidate.
- Ship it as a web app / interactive demo.
- Make it easy for non-technical users to test.
- Avoid complex setup or manual API-key entry for evaluators.

## Knowledge chunks added

Added five chunks:

1. `assessment_project_100x_ai_twin`
   - Describes this project as a deployed AI twin / voice-chat assessment web app.
   - Mentions Next.js, FastAPI, LLM provider integration, RAG, curated profile knowledge base, voice input, responsive UI, and local chat history.

2. `assessment_project_product_depth`
   - Captures product-level details: mobile layout, sidebar, local memory, settings, model details, delete-all-memory, contrast, and scroll behavior.

3. `hundredx_role_fit`
   - Provides the honest role-fit story: strong adjacent agent primitives without falsely claiming production sales-closing agent experience.

4. `hundredx_agent_primitives`
   - Maps Nokia, Hermis, thesis work, RAG, local memory, and event logs to 100x-style agent-building primitives.

5. `hundredx_behavioral_fit`
   - Adds ownership, speed, ambiguity, and accountability evidence from Nokia, Hermis, thesis debugging, and the assessment project.

## Retrieval updates

`backend/app/retrieval.py` now expands and prioritizes terms such as:

- 100x / hundredx
- assessment / Stage 1
- voicebot / voice bot
- AI agent / agents
- RAG / knowledge base
- memory / localStorage / chat history
- owner / ownership / accountability
- shipping / weekly releases / customer-facing improvements
- sales / operations / playbooks / workflows

## Prompt update

`backend/app/prompts.py` now tells the assistant to connect 100x-related answers to AI agents, ownership, fast shipping, user-facing conversational products, RAG, memory, and deployment while avoiding the false claim that Ansuk has already built production sales-closing agents.
