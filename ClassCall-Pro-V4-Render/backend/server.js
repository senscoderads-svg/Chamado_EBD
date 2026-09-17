const express = require("express");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));

const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "admin@classcall.local").trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "123456";
const NODE_ENV = process.env.NODE_ENV || "development";

if (!DATABASE_URL) {
  console.error("DATABASE_URL não configurada.");
  process.exit(1);
}
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error("JWT_SECRET ausente ou curto. Use uma chave aleatória com pelo menos 32 caracteres.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

async function db(text, params=[]) {
  return pool.query(text, params);
}

async function initDb() {
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await db(schema);

  const admin = await db("SELECT id FROM users WHERE email=$1", [ADMIN_EMAIL]);
  if (!admin.rowCount) {
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);
    await db(
      "INSERT INTO users(email,password_hash,role) VALUES($1,$2,'admin')",
      [ADMIN_EMAIL, hash]
    );
    console.log(`Administrador inicial criado: ${ADMIN_EMAIL}`);
  }
}

function sign(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, teacherId: user.teacher_id || null },
    JWT_SECRET,
    { expiresIn: "8h", issuer: "classcall-pro" }
  );
}

function auth(req, res, next) {
  const raw = req.headers.authorization || "";
  const token = raw.startsWith("Bearer ") ? raw.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Não autenticado." });
  try {
    req.user = jwt.verify(token, JWT_SECRET, { issuer: "classcall-pro" });
    next();
  } catch {
    return res.status(401).json({ error: "Sessão expirada ou inválida." });
  }
}
function adminOnly(req,res,next) {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Acesso restrito ao administrador." });
  next();
}
function asyncRoute(fn) {
  return (req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
}

app.get("/api/health", asyncRoute(async (req,res)=>{
  await db("SELECT 1");
  res.json({ ok:true, database:"postgresql", environment:NODE_ENV });
}));

app.post("/api/auth/login", asyncRoute(async (req,res)=>{
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const r = await db("SELECT * FROM users WHERE email=$1", [email]);
  const user = r.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error:"E-mail ou senha inválidos." });
  }
  res.json({ token: sign(user), user:{ id:user.id, email:user.email, role:user.role, teacherId:user.teacher_id }});
}));

app.get("/api/me", auth, asyncRoute(async(req,res)=>{
  res.json({ id:req.user.id, email:req.user.email, role:req.user.role, teacherId:req.user.teacherId });
}));

app.get("/api/dashboard", auth, asyncRoute(async(req,res)=>{
  const [students, classes, teachers, today, week] = await Promise.all([
    db("SELECT COUNT(*)::int AS n FROM students"),
    db("SELECT COUNT(*)::int AS n FROM classes"),
    db("SELECT COUNT(*)::int AS n FROM teachers"),
    db("SELECT COUNT(*) FILTER (WHERE status='present')::int AS present, COUNT(*) FILTER (WHERE status='absent')::int AS absent, COUNT(*) FILTER (WHERE status='late')::int AS late FROM attendance WHERE date=CURRENT_DATE"),
    db("SELECT date, COUNT(*) FILTER (WHERE status='present')::int AS present, COUNT(*) FILTER (WHERE status='absent')::int AS absent, COUNT(*) FILTER (WHERE status='late')::int AS late FROM attendance WHERE date >= CURRENT_DATE-INTERVAL '6 days' GROUP BY date ORDER BY date")
  ]);
  res.json({
    students:Number(students.rows[0].n), classes:Number(classes.rows[0].n), teachers:Number(teachers.rows[0].n),
    today:today.rows[0], week:week.rows
  });
}));

app.get("/api/classes", auth, asyncRoute(async(req,res)=>{
  const r=await db("SELECT * FROM classes ORDER BY name"); res.json(r.rows);
}));
app.post("/api/classes", auth, adminOnly, asyncRoute(async(req,res)=>{
  const r=await db("INSERT INTO classes(name,description) VALUES($1,$2) RETURNING *",[req.body.name,req.body.description||""]);
  res.status(201).json(r.rows[0]);
}));
app.put("/api/classes/:id", auth, adminOnly, asyncRoute(async(req,res)=>{
  const r=await db("UPDATE classes SET name=$1,description=$2 WHERE id=$3 RETURNING *",[req.body.name,req.body.description||"",req.params.id]);
  if(!r.rowCount)return res.status(404).json({error:"Turma não encontrada."}); res.json(r.rows[0]);
}));
app.delete("/api/classes/:id", auth, adminOnly, asyncRoute(async(req,res)=>{
  await db("DELETE FROM classes WHERE id=$1",[req.params.id]); res.json({ok:true});
}));

app.get("/api/teachers", auth, asyncRoute(async(req,res)=>{
  const r=await db("SELECT id,name,email,phone,created_at FROM teachers ORDER BY name"); res.json(r.rows);
}));
app.post("/api/teachers", auth, adminOnly, asyncRoute(async(req,res)=>{
  const {name,email,phone,password}=req.body;
  if(!name||!email||!password) return res.status(400).json({error:"Nome, e-mail e senha são obrigatórios."});
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    const t=await client.query("INSERT INTO teachers(name,email,phone) VALUES($1,$2,$3) RETURNING *",[name,email.trim().toLowerCase(),phone||""]);
    const hash=await bcrypt.hash(password,12);
    const u=await client.query("INSERT INTO users(email,password_hash,role,teacher_id) VALUES($1,$2,'teacher',$3) RETURNING id,email,role,teacher_id",[email.trim().toLowerCase(),hash,t.rows[0].id]);
    await client.query("COMMIT");
    res.status(201).json({...t.rows[0],user:u.rows[0]});
  } catch(e){ await client.query("ROLLBACK"); if(e.code==="23505") return res.status(409).json({error:"E-mail já cadastrado."}); throw e; }
  finally{client.release();}
}));

app.put("/api/teachers/:id", auth, adminOnly, asyncRoute(async(req,res)=>{
  const {name,email,phone,password}=req.body;
  const t=await db("UPDATE teachers SET name=$1,email=$2,phone=$3 WHERE id=$4 RETURNING *",[name,email.trim().toLowerCase(),phone||"",req.params.id]);
  if(!t.rowCount)return res.status(404).json({error:"Professor não encontrado."});
  if(password){
    const hash=await bcrypt.hash(password,12);
    await db("UPDATE users SET email=$1,password_hash=$2 WHERE teacher_id=$3",[email.trim().toLowerCase(),hash,req.params.id]);
  } else await db("UPDATE users SET email=$1 WHERE teacher_id=$2",[email.trim().toLowerCase(),req.params.id]);
  res.json(t.rows[0]);
}));
app.delete("/api/teachers/:id", auth, adminOnly, asyncRoute(async(req,res)=>{
  await db("DELETE FROM users WHERE teacher_id=$1",[req.params.id]);
  await db("DELETE FROM teachers WHERE id=$1",[req.params.id]);
  res.json({ok:true});
}));

app.get("/api/subjects", auth, asyncRoute(async(req,res)=>{
  const r=await db("SELECT s.*,t.name AS teacher_name FROM subjects s LEFT JOIN teachers t ON t.id=s.teacher_id ORDER BY s.name");
  res.json(r.rows);
}));
app.post("/api/subjects", auth, adminOnly, asyncRoute(async(req,res)=>{
  const r=await db("INSERT INTO subjects(name,teacher_id,workload) VALUES($1,$2,$3) RETURNING *",[req.body.name,req.body.teacher_id||null,Number(req.body.workload||0)]);
  res.status(201).json(r.rows[0]);
}));
app.put("/api/subjects/:id", auth, adminOnly, asyncRoute(async(req,res)=>{
  const r=await db("UPDATE subjects SET name=$1,teacher_id=$2,workload=$3 WHERE id=$4 RETURNING *",[req.body.name,req.body.teacher_id||null,Number(req.body.workload||0),req.params.id]);
  if(!r.rowCount)return res.status(404).json({error:"Disciplina não encontrada."}); res.json(r.rows[0]);
}));
app.delete("/api/subjects/:id", auth, adminOnly, asyncRoute(async(req,res)=>{
  await db("DELETE FROM subjects WHERE id=$1",[req.params.id]); res.json({ok:true});
}));

app.get("/api/students", auth, asyncRoute(async(req,res)=>{
  const r=await db("SELECT s.*,c.name AS class_name FROM students s JOIN classes c ON c.id=s.class_id ORDER BY s.name"); res.json(r.rows);
}));
app.post("/api/students", auth, adminOnly, asyncRoute(async(req,res)=>{
  const r=await db("INSERT INTO students(name,registration,class_id) VALUES($1,$2,$3) RETURNING *",[req.body.name,req.body.registration,req.body.class_id]);
  res.status(201).json(r.rows[0]);
}));
app.put("/api/students/:id", auth, adminOnly, asyncRoute(async(req,res)=>{
  const r=await db("UPDATE students SET name=$1,registration=$2,class_id=$3 WHERE id=$4 RETURNING *",[req.body.name,req.body.registration,req.body.class_id,req.params.id]);
  if(!r.rowCount)return res.status(404).json({error:"Aluno não encontrado."}); res.json(r.rows[0]);
}));
app.delete("/api/students/:id", auth, adminOnly, asyncRoute(async(req,res)=>{
  await db("DELETE FROM students WHERE id=$1",[req.params.id]); res.json({ok:true});
}));

app.get("/api/attendance", auth, asyncRoute(async(req,res)=>{
  const date=req.query.date, classId=req.query.class_id, subjectId=req.query.subject_id;
  let sql=`SELECT a.*,s.name AS student_name,s.registration,c.name AS class_name,sub.name AS subject_name
           FROM attendance a JOIN students s ON s.id=a.student_id JOIN classes c ON c.id=a.class_id
           JOIN subjects sub ON sub.id=a.subject_id WHERE 1=1`;
  const p=[];
  if(date){p.push(date);sql+=` AND a.date=$${p.length}`;}
  if(classId){p.push(classId);sql+=` AND a.class_id=$${p.length}`;}
  if(subjectId){p.push(subjectId);sql+=` AND a.subject_id=$${p.length}`;}
  sql+=" ORDER BY s.name";
  const r=await db(sql,p); res.json(r.rows);
}));

app.post("/api/attendance/bulk", auth, asyncRoute(async(req,res)=>{
  const {date,class_id,subject_id,records}=req.body;
  if(!date||!class_id||!subject_id||!Array.isArray(records)) return res.status(400).json({error:"Dados de frequência incompletos."});
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    for(const item of records){
      if(!["present","absent","late"].includes(item.status)) continue;
      await client.query(
        `INSERT INTO attendance(student_id,class_id,subject_id,date,status,recorded_by)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT(student_id,subject_id,date)
         DO UPDATE SET class_id=EXCLUDED.class_id,status=EXCLUDED.status,recorded_by=EXCLUDED.recorded_by,updated_at=NOW()`,
        [item.student_id,class_id,subject_id,date,item.status,req.user.id]
      );
    }
    await client.query("COMMIT"); res.json({ok:true,count:records.length});
  }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
}));

app.get("/api/reports/frequency", auth, asyncRoute(async(req,res)=>{
  const p=[], where=[];
  if(req.query.from){p.push(req.query.from);where.push(`a.date >= $${p.length}`);}
  if(req.query.to){p.push(req.query.to);where.push(`a.date <= $${p.length}`);}
  if(req.query.class_id){p.push(req.query.class_id);where.push(`a.class_id = $${p.length}`);}
  if(req.query.subject_id){p.push(req.query.subject_id);where.push(`a.subject_id = $${p.length}`);}
  const w=where.length?"WHERE "+where.join(" AND "):"";
  const r=await db(`SELECT s.name,s.registration,c.name AS class_name,sub.name AS subject_name,
    COUNT(a.id)::int AS calls,
    COUNT(*) FILTER(WHERE a.status='present')::int AS present,
    COUNT(*) FILTER(WHERE a.status='absent')::int AS absent,
    COUNT(*) FILTER(WHERE a.status='late')::int AS late,
    ROUND((100.0*COUNT(*) FILTER(WHERE a.status IN ('present','late'))/NULLIF(COUNT(a.id),0))::numeric,2) AS frequency
    FROM students s LEFT JOIN attendance a ON a.student_id=s.id
    LEFT JOIN classes c ON c.id=s.class_id LEFT JOIN subjects sub ON sub.id=a.subject_id
    ${w} GROUP BY s.id,c.name,sub.name ORDER BY s.name`,p);
  res.json(r.rows);
}));

app.get("/api/history", auth, asyncRoute(async(req,res)=>{
  const r=await db(`SELECT a.date,c.name AS class_name,sub.name AS subject_name,
    COUNT(*) FILTER(WHERE status='present')::int AS present,
    COUNT(*) FILTER(WHERE status='absent')::int AS absent,
    COUNT(*) FILTER(WHERE status='late')::int AS late,
    ROUND((100.0*COUNT(*) FILTER(WHERE status IN ('present','late'))/NULLIF(COUNT(*),0))::numeric,2) AS frequency
    FROM attendance a JOIN classes c ON c.id=a.class_id JOIN subjects sub ON sub.id=a.subject_id
    GROUP BY a.date,c.name,sub.name ORDER BY a.date DESC,c.name,sub.name`);
  res.json(r.rows);
}));

app.get("/api/backup", auth, adminOnly, asyncRoute(async(req,res)=>{
  const [users,teachers,classes,subjects,students,attendance]=await Promise.all([
    db("SELECT id,email,role,teacher_id,created_at FROM users ORDER BY id"),
    db("SELECT * FROM teachers ORDER BY id"),
    db("SELECT * FROM classes ORDER BY id"),
    db("SELECT * FROM subjects ORDER BY id"),
    db("SELECT * FROM students ORDER BY id"),
    db("SELECT * FROM attendance ORDER BY id")
  ]);
  res.json({exportedAt:new Date().toISOString(),users:users.rows,teachers:teachers.rows,classes:classes.rows,subjects:subjects.rows,students:students.rows,attendance:attendance.rows});
}));

app.use(express.static(path.join(__dirname,"..","frontend")));
app.get("*",(req,res)=>{
  if(req.path.startsWith("/api/")) return res.status(404).json({error:"Rota não encontrada."});
  res.sendFile(path.join(__dirname,"..","frontend","index.html"));
});

app.use((err,req,res,next)=>{
  console.error(err);
  if(err.code==="23505") return res.status(409).json({error:"Registro duplicado."});
  res.status(500).json({error:"Erro interno do servidor."});
});

initDb()
  .then(()=>app.listen(PORT,()=>console.log(`ClassCall Pro V4 online na porta ${PORT}`)))
  .catch(err=>{console.error("Falha ao iniciar:",err);process.exit(1);});

process.on("SIGTERM", async()=>{await pool.end();process.exit(0);});
process.on("SIGINT", async()=>{await pool.end();process.exit(0);});
