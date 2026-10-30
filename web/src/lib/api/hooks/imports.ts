import { useMutation, useQueryClient } from '@tanstack/react-query';
import { invalidateLinkedData, queryKeys } from '../keys';
import type { Account } from '../types';
import { importCsv, type ImportCsvOptions } from '../upload';

/**
 * `POST /accounts/import` over XHR (upload.ts), so the bar moves while the
 * file leaves. The import writes the account and its transactions before it
 * answers, so success lists the account at once (the import panel reports
 * only on an account the list has, so a removed one's report goes) and
 * refreshes accounts and every spending read; the categorize and recurring
 * jobs it returns refresh the rest when they finish (follow them with
 * `useJob`). The error is an `UploadError`; read a 422 `csv_invalid` with
 * `csvProblems`.
 */
export function useImportCsv() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (options: ImportCsvOptions) => importCsv(options),
    onSuccess: ({ account }) => {
      queryClient.setQueryData<Account[]>(queryKeys.accounts(), (accounts) =>
        accounts && !accounts.some((a) => a.id === account.id) ? [...accounts, account] : accounts,
      );
      return invalidateLinkedData(queryClient);
    },
  });
}
