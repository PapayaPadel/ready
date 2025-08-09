require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const MONGO = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/papaya';
const JWT_SECRET = process.env.JWT_SECRET || 'papaya_demo_secret';

mongoose.connect(MONGO, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('Mongo error', err));

const UserSchema = new mongoose.Schema({ name:String, email:{type:String,unique:true}, password:String, role:{type:String,default:'jugador'}, city:String, level:Number }, {timestamps:true});
const TournamentSchema = new mongoose.Schema({ name:String, club_id: mongoose.Schema.Types.ObjectId, format:String, start_date:Date, capacity:Number, status:String, settings:Object }, {timestamps:true});
const ParticipantSchema = new mongoose.Schema({ tournament_id: mongoose.Schema.Types.ObjectId, user_id: mongoose.Schema.Types.ObjectId }, {timestamps:true});
const MatchSchema = new mongoose.Schema({ tournament_id: mongoose.Schema.Types.ObjectId, round:Number, team_a:Object, team_b:Object, status:{type:String,default:'scheduled'} }, {timestamps:true});

const User = mongoose.model('User', UserSchema);
const Tournament = mongoose.model('Tournament', TournamentSchema);
const Participant = mongoose.model('Participant', ParticipantSchema);
const Match = mongoose.model('Match', MatchSchema);

function sign(user){ return jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '7d' }); }

app.post('/api/register', async (req,res)=>{
  try{
    const { name,email,password,role='jugador',city,level } = req.body;
    if(!name||!email||!password) return res.status(400).json({error:'missing fields'});
    if(await User.findOne({email})) return res.status(400).json({error:'user exists'});
    const u = await User.create({name,email,password,role,city,level});
    res.json({ token: sign(u), user:{ id:u._id, name:u.name, email:u.email, role:u.role } });
  }catch(e){ console.error(e); res.status(500).json({error:'server'}); }
});

app.post('/api/login', async (req,res)=>{
  try{
    const { email,password } = req.body;
    const u = await User.findOne({ email, password });
    if(!u) return res.status(401).json({error:'invalid'});
    res.json({ token: sign(u), user:{ id:u._id, name:u.name, role:u.role } });
  }catch(e){ console.error(e); res.status(500).json({error:'server'}); }
});

function auth(req,res,next){
  const h = req.headers.authorization;
  if(!h) return res.status(401).json({error:'no token'});
  const token = h.split(' ')[1];
  try{ req.user = jwt.verify(token, JWT_SECRET); next(); } catch(e){ return res.status(401).json({error:'invalid token'}); }
}

app.post('/api/tournaments', auth, async (req,res)=>{
  try{
    if(!['club','superadmin'].includes(req.user.role)) return res.status(403).json({error:'forbidden'});
    const data = req.body;
    const t = await Tournament.create({ ...data, status:'pending_approval', club_id: req.user.id });
    res.json(t);
  }catch(e){ console.error(e); res.status(500).json({error:'server'}); }
});

app.post('/api/tournaments/:id/approve', auth, async (req,res)=>{
  try{
    if(req.user.role!=='superadmin') return res.status(403).json({error:'forbidden'});
    const t = await Tournament.findByIdAndUpdate(req.params.id, { status:'published' }, { new:true });
    res.json(t);
  }catch(e){ console.error(e); res.status(500).json({error:'server'}); }
});

app.get('/api/tournaments', async (req,res)=>{
  const list = await Tournament.find({ status:'published' }).sort({ start_date:1 }).lean();
  res.json(list);
});

app.post('/api/seed', async (req,res)=>{
  try{
    await Tournament.deleteMany({});
    const sample = [
      { name:'Papaya - Grupos', format:'groups_knockout', start_date:new Date(), capacity:16, status:'published' },
      { name:'Papaya - Knockout', format:'knockout', start_date:new Date(), capacity:8, status:'published' },
      { name:'Papaya - Americano', format:'americano', start_date:new Date(), capacity:12, status:'published' }
    ];
    const created = await Tournament.insertMany(sample);
    res.json(created);
  }catch(e){ console.error(e); res.status(500).json({error:'server'}); }
});

app.post('/api/tournaments/:id/participants', auth, async (req,res)=>{
  try{
    const t = await Tournament.findById(req.params.id);
    if(!t) return res.status(404).json({error:'not found'});
    if(t.format!=='americano') return res.status(400).json({error:'not americano'});
    const exists = await Participant.findOne({ tournament_id: t._id, user_id: req.user.id });
    if(exists) return res.status(400).json({error:'already registered'});
    const p = await Participant.create({ tournament_id: t._id, user_id: req.user.id });
    res.json(p);
  }catch(e){ console.error(e); res.status(500).json({error:'server'}); }
});

app.post('/api/tournaments/:id/generate-americano', auth, async (req,res)=>{
  try{
    const t = await Tournament.findById(req.params.id);
    if(!t) return res.status(404).json({error:'not found'});
    if(!['club','superadmin'].includes(req.user.role)) return res.status(403).json({error:'forbidden'});
    const participants = await Participant.find({ tournament_id: t._id }).lean();
    const players = participants.map(p => p.user_id.toString());
    if(players.length < 2) return res.status(400).json({error:'need at least 2 players'});
    function generateRounds(players){
      let p = players.slice();
      if(p.length % 2 !== 0) p.push(null);
      const n = p.length;
      const rounds = [];
      for(let r=0;r<n-1;r++){
        const pairs = [];
        for(let i=0;i<n/2;i++){
          const a = p[i]; const b = p[n-1-i];
          if(a && b) pairs.push([a,b]);
        }
        const matches = [];
        for(let i=0;i<pairs.length;i+=2){
          if(pairs[i+1]) matches.push({ teamA: pairs[i], teamB: pairs[i+1] });
        }
        rounds.push(matches);
        const last = p.pop();
        p.splice(1,0,last);
      }
      return rounds;
    }
    const rounds = generateRounds(players);
    await Match.deleteMany({ tournament_id: t._id });
    const created = [];
    for(let ri=0;ri<rounds.length;ri++){
      const matches = rounds[ri];
      for(const m of matches){
        const doc = await Match.create({ tournament_id: t._id, round: ri+1, team_a: m.teamA, team_b: m.teamB, status:'scheduled' });
        created.push(doc);
      }
    }
    res.json({ rounds: rounds.length, matches: created.length });
  }catch(e){ console.error(e); res.status(500).json({error:'server'}); }
});

app.get('/api/tournaments/:id/matches', async (req,res)=>{
  const matches = await Match.find({ tournament_id: req.params.id }).lean();
  res.json(matches);
});

// Ruta de prueba para Railway
app.get("/health", (req, res) => {
  res.send("Backend running OK 🚀");
});

app.use(express.static(path.join(__dirname, '..', 'frontend_build')));
app.get('*', (req,res)=>{
  res.sendFile(path.join(__dirname, '..', 'frontend_build', 'index.html'));
});

// Puerto dinámico para Railway
const PORT = process.env.PORT || 5000;
app.listen(PORT, ()=>console.log('Server running on port', PORT));
