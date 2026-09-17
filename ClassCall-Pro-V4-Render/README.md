# ClassCall Pro V4 — Render + PostgreSQL

Versão 4.1 preparada para publicação no Render com PostgreSQL.

## Arquitetura
Navegador → Node.js/Express → PostgreSQL

Os dados do sistema ficam no PostgreSQL. O navegador guarda somente o JWT da sessão.

## Publicação no Render (gratuita)
1. Crie uma conta em https://render.com/
2. Crie um repositório GitHub e envie **todo o conteúdo desta pasta** para ele.
3. No Render, escolha **New → Blueprint** e conecte o repositório.
4. O Render lerá `render.yaml` e criará:
   - 1 Web Service Node
   - 1 PostgreSQL
5. No formulário de implantação, defina `ADMIN_EMAIL` e `ADMIN_PASSWORD`.
6. Aguarde o deploy. O Render fornecerá uma URL HTTPS `*.onrender.com`.
7. Abra a URL e entre com o administrador criado.

## Desenvolvimento local
Requer Node.js 20+ e PostgreSQL.

```bash
cd backend
npm install
```

Defina as variáveis do `.env` (ou no ambiente do sistema) e rode:

```bash
npm start
```

O frontend é servido pelo próprio Express.

## Variáveis
- `DATABASE_URL`: URL do PostgreSQL
- `JWT_SECRET`: segredo JWT (mínimo 32 caracteres)
- `ADMIN_EMAIL`: e-mail do administrador inicial
- `ADMIN_PASSWORD`: senha do administrador inicial
- `NODE_ENV=production`
- `PGSSLMODE=require` para PostgreSQL gerenciado
- `DB_POOL_MAX`: máximo de conexões do pool

## Multiusuário
O administrador pode cadastrar professores em **Professores**. O cadastro cria:
- registro do professor
- conta de login
- senha criptografada com bcrypt

Professor pode entrar e registrar frequência. CRUD administrativo e backup ficam restritos ao administrador.

## Observação importante sobre o plano gratuito
A disponibilidade, limites, suspensão por inatividade e limites do PostgreSQL gratuito dependem das regras vigentes do Render. Antes de usar em produção escolar, confira os limites atuais do seu plano e mantenha backups.

## Segurança
- Não publique `.env`.
- Troque a senha inicial.
- `JWT_SECRET` é gerado pelo Render via `generateValue: true`.
- HTTPS é fornecido pelo Render no endereço do serviço.
- O endpoint `/api/health` está pronto para health check.
