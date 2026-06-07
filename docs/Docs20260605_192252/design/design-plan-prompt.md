## Design Plan aprovado antes do Open Design

Este e o blueprint de produto para o artifact visual. O schema do design-contract e o Design Lock continuam tendo prioridade maxima.
Plano deterministico gerado pelo LionClaw; validacao deterministica: aprovada.


Telas planejadas:
- login (Login) — Autenticar usuario antes de acessar dados protegidos. — stories: US-00
- principal (Principal) — Executar as principais tarefas do produto usando dados das stories aprovadas. — stories: US-00, US-02, US-03, US-04, US-05, US-06, US-07, US-08, US-09, US-10, US-14, US-15, US-16, US-17, US-18, US-19, US-20, US-21

Navegacao planejada:
- Principal -> principal — stories: US-00, US-02, US-03, US-04, US-05, US-06, US-07, US-08, US-09, US-10, US-14, US-15, US-16, US-17, US-18, US-19, US-20, US-21

Vocabulario obrigatorio de dominio:
- dashboard
- registros
- configuracao

Copy proibida ou arriscada:
- acesse seu ambiente
- painel operacional
- eleve sua produtividade

Dados fake recomendados:
(nao declarado)

Instrucoes especificas para Open Design:
- Gere uma SPA operacional, nao uma landing page.
- Use entidades concretas das user stories e evite copy generica.
- Nao escreva regras de negocio na tela; mostre apenas dados, estados, formularios e acoes.
- Gere os fluxos de todas as telas necessarias com navegacao clicavel.
- Arquivo unico index.html e permitido, mas telas empilhadas no scroll sao proibidas. Use [hidden] e JS real para mostrar apenas uma section por vez.

Cobertura planejada:
- US-00: principal — Cobertura deterministica.
- US-02: principal — Cobertura deterministica.
- US-03: principal — Cobertura deterministica.
- US-04: principal — Cobertura deterministica.
- US-05: principal — Cobertura deterministica.
- US-06: principal — Cobertura deterministica.
- US-07: principal — Cobertura deterministica.
- US-08: principal — Cobertura deterministica.
- US-09: principal — Cobertura deterministica.
- US-10: principal — Cobertura deterministica.
- US-14: principal — Cobertura deterministica.
- US-15: principal — Cobertura deterministica.
- US-16: principal — Cobertura deterministica.
- US-17: principal — Cobertura deterministica.
- US-18: principal — Cobertura deterministica.
- US-19: principal — Cobertura deterministica.
- US-20: principal — Cobertura deterministica.
- US-21: principal — Cobertura deterministica.

Regras para usar este plano:
- Use este plano como mapa operacional, nao como copy literal.
- Nao mostre este plano, JSON, criterios internos ou racional no HTML.
- O HTML final deve mostrar apenas a SPA funcional do produto.
- Nao gere landing page, hero, pitch comercial, galeria de telas ou secoes explicativas.
- Um index.html unico e permitido; telas empilhadas no scroll sao proibidas.
- Inclua CSS `[hidden] { display: none !important; }` e JS real para alternar qual `section` esta visivel.
- Login e app shell nunca podem coexistir visualmente. Ao submeter login, esconda login e mostre a primeira tela interna.
- Gere os fluxos de todas as telas necessarias com navegacao clicavel.
- Nao escreva regra de negocio, criterio de aceite ou contrato como texto visivel na UI.