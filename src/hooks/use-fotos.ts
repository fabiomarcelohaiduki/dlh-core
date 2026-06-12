"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  deleteImagem,
  listImagens,
  uploadImagem,
  type ListImagensParams,
  type UploadImagemInput,
} from "@/lib/api/produtos";

/** Chaves de cache das fotos de produto/SKU. */
export const fotoKeys = {
  all: ["produto-imagens"] as QueryKey,
  list: (params: ListImagensParams): QueryKey => ["produto-imagens", params],
};

/** useFotos — fotos de um produto e/ou SKU (GET /produtos-imagens), com signed_url. */
export function useFotos(
  params: ListImagensParams,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: fotoKeys.list(params),
    queryFn: () => listImagens(params),
    enabled:
      (options?.enabled ?? true) &&
      Boolean(params.produto_id || params.sku_id),
  });
}

/** useUploadFoto — envia foto via multipart (POST). Invalida as listas de fotos. */
export function useUploadFoto() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UploadImagemInput) => uploadImagem(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: fotoKeys.all });
    },
  });
}

/** useDeleteFoto — remove foto (DELETE /:id). Invalida as listas de fotos. */
export function useDeleteFoto() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteImagem(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: fotoKeys.all });
    },
  });
}
