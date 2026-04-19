/**
 * @format
 * Job Application Strategist — Shared Types
 *
 * Core type definitions for the 3-agent strategist pipeline:
 *   1. Research Agent — KB retrieval, resume parsing, gap analysis
 *   2. Strategist Agent — 5-phase analysis, document crafting
 *   3. Interview Coach — Stage-specific preparation
 *
 * These types define the data contracts for Step Functions state
 * passing and DynamoDB entity persistence.
 *
 * All types are JSON-serialisable and fit within the 256KB Step
 * Functions payload limit.
 */

import type { AgentResult } from './types.js';

// =============================================================================
// ENUMS & DOMAIN TYPES
// =============================================================================

/**
 * Interview stage progression.
 *
 * Each stage drives the Interview Coach Agent's preparation strategy.
 */
export type InterviewStage =
    | 'applied'
    | 'phone-screen'
    | 'technical-1'
    | 'technical-2'
    | 'behavioural'
    | 'system-design'
    | 'take-home'
    | 'final-round'
    | 'offer'
    | 'rejected'
    | 'withdrawn';

/**
 * Application lifecycle status for DynamoDB tracking.
 */
export type ApplicationStatus =
    | 'analysing'       // Pipeline is running
    | 'analysis-ready'  // Analysis complete, awaiting review
    | 'interview-prep'  // User is preparing for interviews
    | 'applied'          // Application submitted
    | 'interviewing'     // Active interview process
    | 'offer-received'   // Offer extended
    | 'accepted'         // Offer accepted
    | 'rejected'         // Application rejected
    | 'withdrawn';       // Application withdrawn by candidate

/**
 * Overall fit rating for a job application.
 */
export type FitRating = 'STRONG FIT' | 'REASONABLE FIT' | 'STRETCH' | 'REACH';

/**
 * Application recommendation from the Strategist Agent.
 */
export type ApplicationRecommendation =
    | 'APPLY'
    | 'APPLY WITH CAVEATS'
    | 'STRETCH APPLICATION'
    | 'NOT RECOMMENDED';

/**
 * Skill verification depth level.
 */
export type SkillDepth = 'surface' | 'working' | 'expert';

/**
 * Gap type classification.
 */
export type GapType = 'hard' | 'soft';

/**
 * Gap impact severity.
 */
export type GapSeverity = 'blocking' | 'significant' | 'minor';

/**
 * Pipeline operation type — determines which state machine branch to execute.
 *
 * - `analyse`: Research → Strategist → Persist (resume tailoring, gap analysis, cover letter)
 * - `coach`: Load Analysis → Coach → Persist (stage-specific interview preparation)
 */
export type PipelineOperation = 'analyse' | 'coach';

// =============================================================================
// STRUCTURED RESUME DATA
// =============================================================================

/**
 * Profile/contact information from the resume.
 */
export interface ResumeProfile {
    readonly name: string;
    readonly title: string;
    readonly email: string;
    readonly location: string;
    readonly linkedin?: string;
    readonly github?: string;
    readonly website?: string;
}

/**
 * A single professional experience entry.
 */
export interface ResumeExperience {
    readonly company: string;
    readonly title: string;
    readonly period: string;
    readonly highlights: string[];
}

/**
 * A skill category with grouped skills.
 */
export interface ResumeSkillCategory {
    readonly category: string;
    readonly skills: string[];
}

/**
 * Education entry.
 */
export interface ResumeEducation {
    readonly degree: string;
    readonly institution: string;
    readonly period: string;
}

/**
 * Certification entry.
 */
export interface ResumeCertification {
    readonly name: string;
    readonly year: string;
    readonly issuer: string;
}

/**
 * Project entry.
 */
export interface ResumeProject {
    readonly name: string;
    readonly description: string;
    readonly github?: string;
}

/**
 * Key achievement entry.
 */
export interface ResumeAchievement {
    readonly achievement: string;
}

/**
 * Structured resume data — the canonical schema for DynamoDB resume records.
 *
 * Written by the admin UI, read by the Trigger Lambda, and passed through
 * the entire pipeline as structured JSON. Each field maps directly to a
 * resume section.
 *
 * DynamoDB key pattern: pk = 'RESUME#<id>', sk = 'METADATA'
 */
export interface StructuredResumeData {
    readonly profile: ResumeProfile;
    readonly summary: string;
    readonly experience: ResumeExperience[];
    readonly skills: ResumeSkillCategory[];
    readonly education: ResumeEducation[];
    readonly certifications: ResumeCertification[];
    readonly projects: ResumeProject[];
    readonly keyAchievements: ResumeAchievement[];
}

// =============================================================================
// STRATEGIST PIPELINE CONTEXT
// =============================================================================

/**
 * Correlation context for the Strategist Step Functions pipeline.
 *
 * Similar to PipelineContext but specific to job application analysis.
 */
export interface StrategistPipelineContext {
    /** Unique pipeline execution ID */
    readonly pipelineId: string;

    /** Pipeline operation: 'analyse' (Research+Strategist) or 'coach' (Coach only) */
    readonly operation: PipelineOperation;

    /** Job application slug (kebab-case, e.g. 'acme-senior-devops-2026-03') */
    readonly applicationSlug: string;

    /** Raw job description text (only required for 'analyse' operation) */
    readonly jobDescription: string;

    /** Target company name (extracted or provided) */
    readonly targetCompany: string;

    /** Target role title */
    readonly targetRole: string;

    /** Resume ID selected by the user in the admin UI (only for 'analyse' operation) */
    readonly resumeId: string;

    /** Structured resume data fetched by the Trigger Lambda (only for 'analyse' operation) */
    readonly resumeData: StructuredResumeData | null;

    /** Current interview stage (for Coach Agent) */
    readonly interviewStage: InterviewStage;

    /** S3 bucket for pipeline artefacts */
    readonly bucket: string;

    /** Runtime environment */
    readonly environment: string;

    /** Cumulative token usage across all agents */
    cumulativeTokens: {
        input: number;
        output: number;
        thinking: number;
    };

    /** Cumulative estimated cost in USD */
    cumulativeCostUsd: number;

    /** ISO timestamp of pipeline start */
    readonly startedAt: string;

    /** Whether to generate a cover letter (defaults to true if omitted) */
    readonly includeCoverLetter?: boolean;
}

// =============================================================================
// RESEARCH AGENT OUTPUT
// =============================================================================

/**
 * A verified skill match from the candidate's evidence sources.
 */
export interface VerifiedMatch {
    /** The skill or technology */
    readonly skill: string;
    /** Source citation (project name, role, repository) */
    readonly sourceCitation: string;
    /** Depth of expertise */
    readonly depth: SkillDepth;
    /** How recently the skill was used */
    readonly recency: string;
}

/**
 * A partial skill match that needs framing.
 */
export interface PartialMatch {
    /** The skill or technology */
    readonly skill: string;
    /** Description of the gap */
    readonly gapDescription: string;
    /** Transferable foundation that bridges the gap */
    readonly transferableFoundation: string;
    /** Suggested framing for applications */
    readonly framingSuggestion: string;
}

/**
 * A skill gap identified by the Research Agent.
 */
export interface SkillGap {
    /** The missing skill or technology */
    readonly skill: string;
    /** Gap classification */
    readonly gapType: GapType;
    /** Impact on application viability */
    readonly impactSeverity: GapSeverity;
    /** Assessment of whether this gap is disqualifying */
    readonly disqualifyingAssessment: string;
}

/**
 * A hard or soft requirement extracted from the job description.
 */
export interface JobRequirement {
    /** The skill or qualification */
    readonly skill: string;
    /** Context from the JD (e.g. "5+ years production experience") */
    readonly context: string;
    /** Whether not meeting this requirement is likely disqualifying */
    readonly disqualifying?: boolean;
}

/**
 * Technology inventory extracted from the job description.
 */
export interface TechnologyInventory {
    readonly languages: string[];
    readonly frameworks: string[];
    readonly infrastructure: string[];
    readonly tools: string[];
    readonly methodologies: string[];
}

/**
 * Experience signals extracted from the job description.
 */
export interface ExperienceSignals {
    /** Expected years of experience (e.g. "3-5") */
    readonly yearsExpected: string;
    /** Required domain experience (e.g. "fintech") */
    readonly domainExperience: string;
    /** Leadership expectations */
    readonly leadershipExpectation: string;
    /** Scale indicators (e.g. "100k+ users") */
    readonly scaleIndicators: string;
}

/**
 * Complete output from the Strategist Research Agent.
 */
export interface StrategistResearchResult {
    /** Extracted target role title */
    readonly targetRole: string;
    /** Extracted target company name */
    readonly targetCompany: string;
    /** Assessed seniority level */
    readonly seniority: string;
    /** Role domain classification */
    readonly domain: string;

    /** Requirements extracted from the JD */
    readonly hardRequirements: JobRequirement[];
    readonly softRequirements: JobRequirement[];
    readonly implicitRequirements: string[];

    /** Technology inventory from the JD */
    readonly technologyInventory: TechnologyInventory;

    /** Experience signals from the JD */
    readonly experienceSignals: ExperienceSignals;

    /** Skills verified against KB and resume data */
    readonly verifiedMatches: VerifiedMatch[];

    /** Skills with partial evidence */
    readonly partialMatches: PartialMatch[];

    /** Skills with no evidence */
    readonly gaps: SkillGap[];

    /** Overall fit assessment */
    readonly overallFitRating: FitRating;

    /** One-paragraph honest assessment */
    readonly fitSummary: string;

    /** Structured resume data passed through pipeline context (source of truth) */
    readonly resumeData: StructuredResumeData | null;

    /** Concatenated KB passages with source citations */
    readonly kbContext: string;

    /** Resume domain constraints — rules, gaps, and status thresholds (non-negotiable) */
    readonly resumeConstraints: string;
}

// =============================================================================
// ROLE ARCHETYPE SELECTION (Phase 0)
// =============================================================================

/**
 * Valid archetype IDs — maps to the 6 archetypes in the wiki role-archetypes page.
 */
export type ArchetypeId = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * Explicit archetype selection output from Strategist Phase 0.
 *
 * Phase 0 runs before any resume generation and determines which
 * archetype lens governs emphasis, exclusions, and lead identity.
 * Surfaced as a distinct, auditable XML section so failures trace
 * to a specific archetype mismatch rather than to downstream generation.
 */
export interface RoleArchetypeSelection {
    /**
     * Archetype name — e.g. "Site Reliability Engineer (SRE)".
     * Maps directly to the archetype titles in role-archetypes.md.
     */
    readonly selectedArchetype: string;

    /**
     * Numeric archetype ID (1–6) for programmatic routing.
     * 1 = Platform/Infra, 2 = SRE, 3 = Full-Stack,
     * 4 = AI/ML, 5 = DevOps/Cloud, 6 = Ops Engineering/Internal Tooling.
     */
    readonly archetypeId: ArchetypeId;

    /** JD phrases that triggered this archetype selection. */
    readonly triggerPhrasesMatched: string[];

    /**
     * Content categories excluded by this archetype.
     * e.g. for Archetype 6: ["Next.js/React", "DynamoDB single-table design"]
     */
    readonly excludedContentCategories: string[];

    /** One-sentence lead identity for this archetype and role. */
    readonly leadIdentity: string;

    /**
     * Selection confidence (0.0–1.0).
     * Below 0.8 → archetypeGapDetected = true → flag for human review.
     */
    readonly confidenceScore: number;

    /**
     * True when no archetype matches with confidence ≥ 0.8.
     * Action: use closest match but flag the output for human review.
     */
    readonly archetypeGapDetected: boolean;
}

// =============================================================================
// RESUME SUGGESTION TYPES
// =============================================================================

/**
 * A single resume addition suggestion — maps to <addition> in the
 * Strategist Agent's XML output.
 *
 * Tells the user which section to add a bullet to, what text to add,
 * and which KB project citation backs the claim.
 */
export interface ResumeAdditionSuggestion {
    /** Resume section target (e.g. "Experience — DevOps at Acme") */
    readonly section: string;
    /** Suggested bullet point text */
    readonly suggestedBullet: string;
    /** KB source citation backing the claim */
    readonly sourceCitation: string;
}

/**
 * A single resume reframe suggestion — maps to <reframe> in the
 * Strategist Agent's XML output.
 *
 * Proposes replacing an existing bullet with improved wording
 * that better aligns with the target job description.
 */
export interface ResumeReframeSuggestion {
    /** Original resume text to replace */
    readonly original: string;
    /** Suggested replacement text */
    readonly suggested: string;
    /** Why this reframe improves the application */
    readonly rationale: string;
}

/**
 * A single ESL correction — maps to <correction> in the
 * Strategist Agent's XML output.
 *
 * Fixes grammar, spelling, or phrasing issues that may
 * undermine professionalism.
 */
export interface ResumeEslCorrection {
    /** Original text with error */
    readonly original: string;
    /** Corrected text */
    readonly corrected: string;
}

/**
 * Structured resume tailoring suggestions with per-item detail.
 *
 * Parsed from the `<resume_tailoring>` XML section of the
 * Strategist Agent's output. Provides actionable, section-level
 * suggestions for the admin UI.
 */
export interface ResumeSuggestions {
    /** New bullet points to add (with section target and KB citation) */
    readonly additions: ResumeAdditionSuggestion[];
    /** Existing bullets to reword (with original, replacement, and rationale) */
    readonly reframes: ResumeReframeSuggestion[];
    /** Grammar/spelling corrections */
    readonly eslCorrections: ResumeEslCorrection[];
}

// =============================================================================
// STRATEGIST AGENT OUTPUT
// =============================================================================

/**
 * Complete XML analysis output from the Strategist Agent.
 *
 * This is the raw XML string; the handler parses specific sections
 * as needed. The full XML is persisted to DynamoDB for admin review.
 */
export interface StrategistAnalysisResult {
    /** The full XML analysis (raw string) */
    readonly analysisXml: string;

    /** Extracted metadata for quick DynamoDB queries */
    readonly metadata: {
        readonly candidateName: string;
        readonly targetRole: string;
        readonly targetCompany: string;
        readonly analysisDate: string;
        readonly overallFitRating: FitRating;
        readonly applicationRecommendation: ApplicationRecommendation;
    };

    /** Generated cover letter (extracted from XML, null when not requested) */
    readonly coverLetter: string | null;

    /**
     * Explicit archetype selection from Phase 0.
     * Null when the Strategist did not output a Phase 0 section (legacy runs).
     */
    readonly archetypeSelection: RoleArchetypeSelection | null;

    /**
     * Complete tailored StructuredResumeData produced by the Strategist in Phase 4.
     *
     * This is the authoritative tailored resume — generated directly by Sonnet 4.6
     * with extended thinking. The Resume Builder handler persists this directly to
     * DynamoDB without any LLM-based patch application.
     *
     * Null when no resume was provided (build-from-scratch without base data)
     * or when the Strategist did not output a <tailored_resume_json> section.
     */
    readonly tailoredResumeData: StructuredResumeData | null;

    /**
     * Structured per-item resume tailoring suggestions (parsed from XML).
     * Retained for admin UI audit trail — shows what changed and why.
     * NOT used by the Resume Builder to apply patches (deprecated role).
     */
    readonly resumeSuggestions: ResumeSuggestions;

    /**
     * Resume addition count.
     * @deprecated Use `resumeSuggestions.additions.length` — kept for backward compatibility.
     */
    readonly resumeAdditions: number;

    /**
     * Resume reframe count.
     * @deprecated Use `resumeSuggestions.reframes.length` — kept for backward compatibility.
     */
    readonly resumeReframes: number;

    /**
     * ESL correction count.
     * @deprecated Use `resumeSuggestions.eslCorrections.length` — kept for backward compatibility.
     */
    readonly eslCorrections: number;
}

// =============================================================================
// INTERVIEW COACH OUTPUT
// =============================================================================

/**
 * A single interview question with preparation framework.
 */
export interface InterviewQuestion {
    /** Likely question text */
    readonly question: string;
    /** STAR-based answer framework using verified experience */
    readonly answerFramework: string;
    /** Source project from KB */
    readonly sourceProject: string;
    /** Difficulty level */
    readonly difficulty: 'easy' | 'medium' | 'hard';
    /** Key points to hit in the answer */
    readonly keyPoints: string[];
}

/**
 * A difficult or gap-probing question with bridge strategy.
 */
export interface DifficultQuestion {
    /** The challenging question */
    readonly question: string;
    /** Framework for honest positioning */
    readonly answerFramework: string;
    /** Strategy for bridging from gap to strength */
    readonly bridgeStrategy: string;
}

/**
 * A technical preparation checklist item.
 */
export interface TechnicalPrepItem {
    /** Topic to prepare */
    readonly topic: string;
    /** Priority level */
    readonly priority: 'high' | 'medium' | 'low';
    /** Why this topic matters for the interview */
    readonly rationale: string;
    /** Suggested preparation resources */
    readonly suggestedResources: string[];
}

/**
 * A question to ask the interviewer.
 */
export interface QuestionToAsk {
    /** The question text */
    readonly question: string;
    /** Why this question demonstrates good candidacy */
    readonly rationale: string;
}

/**
 * Complete output from the Interview Coach Agent.
 */
export interface InterviewCoachResult {
    /** Current interview stage */
    readonly stage: InterviewStage;
    /** Human-readable stage description */
    readonly stageDescription: string;

    /** Technical questions with preparation frameworks */
    readonly technicalQuestions: InterviewQuestion[];
    /** Behavioural questions with STAR-based answers */
    readonly behaviouralQuestions: InterviewQuestion[];
    /** Difficult or gap-probing questions */
    readonly difficultQuestions: DifficultQuestion[];
    /** Technical preparation checklist */
    readonly technicalPrepChecklist: TechnicalPrepItem[];
    /** Questions to ask the interviewer */
    readonly questionsToAsk: QuestionToAsk[];
    /** Stage-specific coaching notes */
    readonly coachingNotes: string;
}

// =============================================================================
// DYNAMODB ENTITY — JOB APPLICATION RECORD
// =============================================================================

/**
 * DynamoDB entity for tracking job applications.
 *
 * Entity schema:
 *   pk: APPLICATION#<slug>
 *   sk: METADATA — current analysis state and lifecycle status
 *   sk: ANALYSIS#<pipelineId> — versioned full analysis XML
 *   sk: INTERVIEW#<stage> — stage-specific interview prep
 *
 * GSI1 (status-date):
 *   gsi1pk: APP_STATUS#<status>
 *   gsi1sk: <YYYY-MM-DD>#<slug>
 *
 * GSI2 (company):
 *   gsi2pk: COMPANY#<company>
 *   gsi2sk: <YYYY-MM-DD>#<slug>
 */
export interface JobApplicationRecord {
    /** Partition key: APPLICATION#<slug> */
    readonly pk: string;
    /** Sort key: METADATA | ANALYSIS#<id> | INTERVIEW#<stage> */
    readonly sk: string;

    /** Application lifecycle status */
    readonly status: ApplicationStatus;
    /** Pipeline execution ID */
    readonly pipelineId: string;
    /** Application slug */
    readonly applicationSlug: string;
    /** Target company */
    readonly targetCompany: string;
    /** Target role title */
    readonly targetRole: string;
    /** Overall fit rating */
    readonly fitRating: FitRating;
    /** Application recommendation */
    readonly recommendation: ApplicationRecommendation;
    /** Current interview stage */
    readonly interviewStage: InterviewStage;

    /** ISO timestamp of creation */
    readonly createdAt: string;
    /** ISO timestamp of last update */
    readonly updatedAt: string;
    /** Runtime environment */
    readonly environment: string;

    /** GSI1 partition key: APP_STATUS#<status> */
    readonly gsi1pk: string;
    /** GSI1 sort key: <YYYY-MM-DD>#<slug> */
    readonly gsi1sk: string;

    /** GSI2 partition key: COMPANY#<company> */
    readonly gsi2pk?: string;
    /** GSI2 sort key: <YYYY-MM-DD>#<slug> */
    readonly gsi2sk?: string;

    /** Full analysis XML (only on ANALYSIS# sort key items) */
    readonly analysisXml?: string;
    /** Interview prep JSON (only on INTERVIEW# sort key items) */
    readonly interviewPrep?: string;
}

// =============================================================================
// RESUME BUILDER AGENT OUTPUT (Phase 4b)
// =============================================================================

/**
 * Output from the Resume Builder Agent.
 *
 * Contains the rebuilt resume with all Strategist suggestions applied.
 */
export interface TailoredResumeResult {
    /**
     * The complete tailored resume.
     *
     * In the current pipeline (Option A), this is sourced directly from
     * `StrategistAnalysisResult.tailoredResumeData` — produced by the
     * Strategist Agent and validated by the Resume Builder handler.
     * No LLM patch application occurs in the Resume Builder stage.
     */
    readonly tailoredResume: StructuredResumeData;

    /** Human-readable summary of the tailoring (from Strategist Phase 0 archetype selection). */
    readonly changesSummary: string;

    /**
     * @deprecated Always 0 — patch application removed in Option A architecture.
     * The Strategist produces the complete resume directly.
     */
    readonly additionsApplied: number;

    /**
     * @deprecated Always 0 — patch application removed in Option A architecture.
     */
    readonly reframesApplied: number;

    /**
     * @deprecated Always 0 — patch application removed in Option A architecture.
     */
    readonly eslCorrectionsApplied: number;
}

// =============================================================================
// STEP FUNCTIONS STATE SHAPES — ANALYSIS PIPELINE
// =============================================================================

/**
 * Input to the Strategist Research Handler.
 */
export interface StrategistResearchHandlerInput {
    readonly context: StrategistPipelineContext;
}

/**
 * Output from Research Handler, input to Strategist Handler.
 */
export interface StrategistWriterHandlerInput {
    readonly context: StrategistPipelineContext;
    readonly research: AgentResult<StrategistResearchResult>;
}

/**
 * Output from Strategist Handler, input to Resume Builder Handler.
 */
export interface ResumeBuilderHandlerInput {
    readonly context: StrategistPipelineContext;
    readonly research: AgentResult<StrategistResearchResult>;
    readonly analysis: AgentResult<StrategistAnalysisResult>;
}

/**
 * Output from Resume Builder Handler, input to Analysis Persist Handler.
 */
export interface ResumeBuilderHandlerOutput {
    readonly context: StrategistPipelineContext;
    readonly research: AgentResult<StrategistResearchResult>;
    readonly analysis: AgentResult<StrategistAnalysisResult>;
    /** Null when no resume data or no suggestions to apply */
    readonly tailoredResume: AgentResult<TailoredResumeResult> | null;
}

/**
 * Output from Strategist Handler, input to Analysis Persist Handler.
 *
 * Note: The persist handler accepts both the legacy direct-from-strategist
 * input and the post-resume-builder input (with tailoredResume field).
 */
export interface StrategistAnalysisPersistInput {
    readonly context: StrategistPipelineContext;
    readonly research: AgentResult<StrategistResearchResult>;
    readonly analysis: AgentResult<StrategistAnalysisResult>;
    /** Tailored resume — present when Resume Builder Agent ran (Phase 4b) */
    readonly tailoredResume?: AgentResult<TailoredResumeResult> | null;
}

/**
 * Terminal output from the Analysis Pipeline.
 */
export interface StrategistAnalysisPipelineOutput {
    readonly context: StrategistPipelineContext;
    readonly research: AgentResult<StrategistResearchResult>;
    readonly analysis: AgentResult<StrategistAnalysisResult>;
    /** Tailored resume — present when Resume Builder Agent ran (Phase 4b) */
    readonly tailoredResume?: AgentResult<TailoredResumeResult> | null;
    /** Final application status written to DynamoDB */
    readonly applicationStatus: ApplicationStatus;
}

// =============================================================================
// STEP FUNCTIONS STATE SHAPES — COACHING PIPELINE
// =============================================================================

/**
 * Input to the Coach Loader Handler.
 *
 * Minimal context — the loader fetches the latest analysis from DDB.
 */
export interface StrategistCoachLoaderInput {
    readonly context: StrategistPipelineContext;
}

/**
 * Output from Coach Loader, input to Coach Handler.
 *
 * The analysis is loaded from DynamoDB (not piped from the analysis chain).
 */
export interface StrategistCoachHandlerInput {
    readonly context: StrategistPipelineContext;
    readonly analysis: AgentResult<StrategistAnalysisResult>;
}

/**
 * Terminal output from the Coaching Pipeline.
 */
export interface StrategistCoachPipelineOutput {
    readonly context: StrategistPipelineContext;
    readonly coaching: AgentResult<InterviewCoachResult>;
    /** Final application status written to DynamoDB */
    readonly applicationStatus: ApplicationStatus;
}

// =============================================================================
// LEGACY — COMBINED PIPELINE OUTPUT
// =============================================================================

/**
 * Union output — the trigger returns whichever pipeline was executed.
 *
 * Discriminated by `applicationStatus`: 'analysis-ready' for analysis,
 * 'interviewing' for coaching.
 */
export type StrategistPipelineOutput =
    | StrategistAnalysisPipelineOutput
    | StrategistCoachPipelineOutput;
