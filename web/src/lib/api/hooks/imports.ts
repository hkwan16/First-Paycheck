import { useMutation, useQueryClient } from '@tanstack/react-query';
import { invalidateLinkedData } from '../keys';
import { importCsv, type ImportCsvOptions } from '../upload';

/**
 * `POST /accounts/import` over XHR (upload.ts), so the bar moves while the
 * file leaves. The import writes the account and its transactions before it
 * answers, so success refreshes accounts and every spending read at once;
 * the categorize and recurring jobs it returns refresh the rest when they
 * finish (follow them with `useJob`). The error is an `UploadError`; read a
 * 422 `csv_invalid` with `csvProblems`.
 */
export function useImportCsv() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (options: ImportCsvOptions) => importCsv(options),
    onSuccess: () => invalidateLinkedData(queryClient),
  });
}
