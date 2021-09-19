import { Injectable } from '@angular/core';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { SnackService } from '../../../../../core/snack/snack.service';
import { TaskService } from '../../../../tasks/task.service';
import { ProjectService } from '../../../../project/project.service';
import { concatMap, filter, first, map, switchMap, tap } from 'rxjs/operators';
import { IssueService } from '../../../issue.service';
import { forkJoin, Observable, timer } from 'rxjs';
import { Task, TaskWithSubTasks } from 'src/app/features/tasks/task.model';
import { WorkContextService } from '../../../../work-context/work-context.service';
import { CALDAV_TYPE } from '../../../issue.const';
import { IssueEffectHelperService } from '../../../issue-effect-helper.service';
import { CALDAV_INITIAL_POLL_DELAY, CALDAV_POLL_INTERVAL } from '../caldav.const';
import { isCaldavEnabled } from '../is-caldav-enabled.util';
import { CaldavClientService } from '../caldav-client.service';
import { CaldavCfg } from '../caldav.model';
import { updateTask } from '../../../../tasks/store/task.actions';

@Injectable()
export class CaldavIssueEffects {
  // TODO only check if there are active issue tasks for current list
  checkForDoneTransition$: Observable<any> = createEffect(
    () =>
      this._actions$.pipe(
        ofType(updateTask),
        filter(({ task }): boolean => 'isDone' in task.changes),
        concatMap(({ task }) => this._taskService.getByIdOnce$(task.id as string)),
        filter((task: Task) => task && task.issueType === CALDAV_TYPE),
        concatMap((task: Task) => {
          if (!task.projectId) {
            throw new Error('No projectId for task');
          }
          return this._getCfgOnce$(task.projectId).pipe(
            map((caldavCfg) => ({ caldavCfg, task })),
          );
        }),
        filter(
          ({ caldavCfg: caldavCfg, task }) =>
            isCaldavEnabled(caldavCfg) && caldavCfg.isTransitionIssuesEnabled,
        ),
        concatMap(({ caldavCfg: caldavCfg, task }) => {
          return this._handleTransitionForIssue$(caldavCfg, task);
        }),
      ),
    { dispatch: false },
  );

  private _pollTimer$: Observable<any> = timer(
    CALDAV_INITIAL_POLL_DELAY,
    CALDAV_POLL_INTERVAL,
  );

  private _updateIssuesForCurrentContext$: Observable<any> =
    this._workContextService.allTasksForCurrentContext$.pipe(
      first(),
      switchMap((tasks) => {
        const caldavIssueTasks = tasks.filter((task) => task.issueType === CALDAV_TYPE);
        return forkJoin(
          caldavIssueTasks.map((task) => {
            if (!task.projectId) {
              throw new Error('No project for task');
            }
            return this._projectService.getCaldavCfgForProject$(task.projectId).pipe(
              first(),
              map((cfg) => ({
                cfg,
                task,
              })),
            );
          }),
        );
      }),
      map((cos) =>
        cos
          .filter(
            ({ cfg, task }: { cfg: CaldavCfg; task: TaskWithSubTasks }): boolean =>
              isCaldavEnabled(cfg) && cfg.isAutoPoll,
          )
          .map(({ task }: { cfg: CaldavCfg; task: TaskWithSubTasks }) => task),
      ),
      tap((caldavTasks: TaskWithSubTasks[]) => this._refreshIssues(caldavTasks)),
    );

  pollIssueChangesForCurrentContext$: Observable<any> = createEffect(
    () =>
      this._issueEffectHelperService.pollIssueTaskUpdatesActions$.pipe(
        switchMap(() => this._pollTimer$),
        switchMap(() => this._updateIssuesForCurrentContext$),
      ),
    { dispatch: false },
  );

  constructor(
    private readonly _actions$: Actions,
    private readonly _snackService: SnackService,
    private readonly _projectService: ProjectService,
    private readonly _caldavClientService: CaldavClientService,
    private readonly _issueService: IssueService,
    private readonly _taskService: TaskService,
    private readonly _workContextService: WorkContextService,
    private readonly _issueEffectHelperService: IssueEffectHelperService,
  ) {}

  private _refreshIssues(caldavTasks: TaskWithSubTasks[]): void {
    if (caldavTasks && caldavTasks.length > 0) {
      this._issueService.refreshIssues(caldavTasks);
    }
  }

  private _handleTransitionForIssue$(caldavCfg: CaldavCfg, task: Task): Observable<any> {
    return this._caldavClientService
      .updateCompletedState$(caldavCfg, task.issueId as string, task.isDone)
      .pipe(concatMap(() => this._issueService.refreshIssue(task, true)));
  }

  private _getCfgOnce$(projectId: string): Observable<CaldavCfg> {
    return this._projectService.getCaldavCfgForProject$(projectId).pipe(first());
  }
}
