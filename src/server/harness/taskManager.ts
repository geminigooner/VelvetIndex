// taskManager.ts — Stateful task manager for side-effecting Research Acquisition workflows.
import { randomUUID } from "node:crypto";
import type { ResearchTaskState, ResearchPaperCandidate, TaskStatus } from "./types.ts";

export class ResearchTaskManager {
  private tasks: Map<string, ResearchTaskState> = new Map();

  createTask(query: string, venues: string[]): ResearchTaskState {
    const taskId = `task_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const task: ResearchTaskState = {
      taskId,
      query,
      venues,
      createdAt: now,
      updatedAt: now,
      status: 'idle',
      progressPercent: 0,
      currentStepMessage: 'Task registered and ready for execution',
      papers: [],
    };
    this.tasks.set(taskId, task);
    return task;
  }

  getTask(taskId: string): ResearchTaskState | undefined {
    return this.tasks.get(taskId);
  }

  getAllTasks(): ResearchTaskState[] {
    return Array.from(this.tasks.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  updateTask(
    taskId: string,
    updates: Partial<Omit<ResearchTaskState, 'taskId' | 'createdAt'>>
  ): ResearchTaskState {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const updated: ResearchTaskState = {
      ...task,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    this.tasks.set(taskId, updated);
    return updated;
  }

  setPaperStatus(taskId: string, paperId: string, status: 'approved' | 'rejected'): ResearchPaperCandidate {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const paper = task.papers.find((p) => p.id === paperId);
    if (!paper) throw new Error(`Paper not found: ${paperId} in task ${taskId}`);

    paper.status = status;
    task.updatedAt = new Date().toISOString();

    const anyApproved = task.papers.some((p) => p.status === 'approved');
    if (anyApproved && task.status !== 'approved') {
      task.status = 'approved';
    }

    return paper;
  }

  getApprovedPapers(taskId: string): ResearchPaperCandidate[] {
    const task = this.tasks.get(taskId);
    if (!task) return [];
    return task.papers.filter((p) => p.status === 'approved');
  }
}

export const taskManager = new ResearchTaskManager();
