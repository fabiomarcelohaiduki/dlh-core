"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Check, Loader2, TriangleAlert, X } from "lucide-react";
import {
  useCreateClienteRevenda,
  useUpdateClienteRevenda,
} from "@/hooks/use-revenda";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { ClienteRevenda } from "@/lib/api/types";

const clienteSchema = z.object({
  nome: z.string().trim().min(1, "Informe o nome do cliente."),
  ativo: z.boolean(),
});
type ClienteValues = z.infer<typeof clienteSchema>;

/**
 * cmp-cliente-revenda-form — cria/edita um cliente do canal de revenda
 * (clientes_revenda). O toggle `ativo` so aparece na edicao (clientes nao sao
 * removidos, apenas inativados). Validacao react-hook-form + zod inline; nao
 * cria registro parcial em erro.
 */
export function ClienteRevendaForm({
  cliente,
  onSuccess,
  onCancel,
}: {
  cliente?: ClienteRevenda;
  onSuccess?: (cliente: ClienteRevenda) => void;
  onCancel?: () => void;
}) {
  const isEdit = Boolean(cliente);
  const createCliente = useCreateClienteRevenda();
  const updateCliente = useUpdateClienteRevenda();
  const pending = createCliente.isPending || updateCliente.isPending;

  const [apiError, setApiError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<ClienteValues>({
    resolver: zodResolver(clienteSchema),
    defaultValues: {
      nome: cliente?.nome ?? "",
      ativo: cliente?.ativo ?? true,
    },
  });

  const ativo = watch("ativo");

  async function onSubmit(values: ClienteValues) {
    setApiError(null);
    const input = { nome: values.nome.trim(), ativo: values.ativo };
    try {
      const saved =
        isEdit && cliente
          ? await updateCliente.mutateAsync({ id: cliente.id, input })
          : await createCliente.mutateAsync(input);
      onSuccess?.(saved);
    } catch (err) {
      setApiError(
        err instanceof ApiError && err.status === 409
          ? "Já existe um cliente de revenda com este nome."
          : err instanceof ApiError && err.status === 400
            ? "Dados inválidos: revise o nome do cliente."
            : "Não foi possível salvar o cliente. Tente novamente.",
      );
    }
  }

  return (
    <form
      className="card form-card--wide"
      onSubmit={handleSubmit(onSubmit)}
      noValidate
    >
      <div className="section-title" style={{ margin: "0 0 16px" }}>
        <h3>{isEdit ? "Editar cliente" : "Novo cliente de revenda"}</h3>
      </div>

      <div className="grid-fields">
        <div className={cn("field", errors.nome && "invalid")}>
          <label htmlFor="cliente-nome">Nome</label>
          <input
            id="cliente-nome"
            type="text"
            placeholder="ex.: Distribuidora Atlântico"
            aria-invalid={Boolean(errors.nome)}
            {...register("nome")}
          />
          <div className="err-msg">
            <TriangleAlert aria-hidden="true" />
            {errors.nome?.message ?? "Informe o nome do cliente."}
          </div>
        </div>

        {isEdit && (
          <label className="chk" style={{ alignSelf: "end" }}>
            <input
              type="checkbox"
              checked={ativo}
              onChange={(e) =>
                setValue("ativo", e.target.checked, { shouldDirty: true })
              }
            />
            <div className="t">Ativo</div>
          </label>
        )}
      </div>

      <div className="form-foot" style={{ marginTop: 22 }}>
        <button className="btn btn-primary" type="submit" disabled={pending}>
          {pending ? (
            <Loader2 className="spin" aria-hidden="true" />
          ) : (
            <Check aria-hidden="true" />
          )}
          <span>
            {pending ? "Salvando…" : isEdit ? "Salvar cliente" : "Criar cliente"}
          </span>
        </button>
        {onCancel && (
          <button
            className="btn"
            type="button"
            onClick={onCancel}
            disabled={pending}
          >
            <X aria-hidden="true" />
            <span>Cancelar</span>
          </button>
        )}
        {apiError && (
          <span className="save-note err">
            <TriangleAlert aria-hidden="true" />
            {apiError}
          </span>
        )}
      </div>
    </form>
  );
}
